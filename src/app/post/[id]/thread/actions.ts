"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { notifyMessageLive } from "@/notify/live";
import { UUID } from "@/post/post-form";
import { MESSAGE_BODY_MAX, threadIsOpen } from "@/post/thread-view";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Send a message in a match's thread (story #35 AC 2). One write, through the caller's own
 * cookie-bound client, so 0020's policies decide: a party inserts as themselves, and a third
 * person or a forged author_id is refused by the database whatever this code believes.
 *
 * EVERY CHECK HERE IS MADE AGAIN EVEN THOUGH THE PAGE ALREADY MADE IT. A Server Action is a POST
 * endpoint reachable by anyone who can send the request — Next's own security guide says
 * render-time gating is not a security boundary — so "the form was not rendered" stops nobody.
 * The three that matter:
 *
 *   the 2,000-character cap  checked here for a civil refusal, and again by 0020's check
 *                            constraint, which is where the rule is actually true.
 *   the party predicate      checked by 0020's with-check policy, not by an `if` here: the
 *                            database is the only place that cannot be bypassed, and a refusal
 *                            comes back as an error we report rather than as a row.
 *   the seven-day close      checked here against the race date read from the database, because
 *                            RLS cannot express it — a policy has no access to "seven days after
 *                            starts_at" without a join the insert path should not carry. This is
 *                            the one rule whose only enforcement is this function, which is why
 *                            it is read from the row and not from the form.
 *
 * Returns state rather than redirecting on refusal (AC 2's "refused at the server action"): the
 * form is a Client Component using useActionState, so the person keeps what they typed and reads
 * the reason beside the box. A SUCCESS still revalidates and returns clean state — the thread is
 * a Server Component, so the new message arrives with the re-render.
 */

export type SendState = {
  /** A reason code the form turns into a sentence (thread-view.ts), or null when it worked. */
  error: string | null;
  /** Kept so a refused message is not lost from the textarea. */
  body?: string;
};

export async function sendMessage(postId: string, _prev: SendState, formData: FormData): Promise<SendState> {
  if (!UUID.test(postId)) return { error: "refused" };

  const raw = formData.get("body");
  const body = typeof raw === "string" ? raw.trim() : "";
  if (body.length === 0) return { error: "empty", body: typeof raw === "string" ? raw : "" };
  if (body.length > MESSAGE_BODY_MAX) return { error: "too_long", body };

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  // The match and its race date, read as the caller: 0008's policy hands a party the match on a
  // post they can see, so a non-party gets nothing here and is refused before the insert. The
  // race date comes with it because the seven-day rule has no other source of truth.
  const { data: match } = await client
    .from("match")
    .select("id, post:post_id (race_date:race_date_id (starts_at))")
    .eq("post_id", postId)
    .maybeSingle();
  if (!match) return { error: "refused", body };

  // PostgREST types a to-one embed as object-or-array; narrow both hops the way the notify
  // stores do. No filter names either embed, which is what keeps this read honest — a filter on
  // an embedded resource is applied to the embed and leaves the parent with a null (cairn:
  // postgrest-filtering-on-an-embedded-resource).
  const post = (Array.isArray(match.post) ? match.post[0] : match.post) as
    | { race_date: { starts_at: string } | { starts_at: string }[] }
    | null;
  const date = post ? ((Array.isArray(post.race_date) ? post.race_date[0] : post.race_date) as { starts_at: string } | null) : null;
  if (!date) return { error: "refused", body };
  if (!threadIsOpen(date.starts_at, new Date())) return { error: "closed", body };

  const { data: created, error } = await client
    .from("message")
    .insert({ match_id: match.id, author_id: user.id, body })
    .select("id")
    .single();
  // 42501 is 0020's policy refusing a non-party or a forged author; 23514 is its length check,
  // which this function's own cap should have caught first. Either way the person sees a
  // refusal and no row exists.
  if (error || !created) return { error: "refused", body };

  // The notification is a side effect of a row that already stands: a failure in it must not
  // undo the message or show the author an error about the other person's inbox (notify/live.ts
  // swallows for exactly this reason).
  await notifyMessageLive(created.id);

  revalidatePath(`/post/${postId}/thread`);
  return { error: null };
}
