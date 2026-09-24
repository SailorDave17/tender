import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatStartsAt, whenLabel } from "@/dates/race-date";
import { FORMER_MEMBER, matchRole, partyName } from "@/post/match-view";
import { UUID } from "@/post/post-form";
import { SendMessageForm } from "@/post/SendMessageForm";
import { WithdrawnPost, readWithdrawnDay } from "@/post/withdrawn";
import { THREAD_CLOSED_NOTE, messageText, threadClosesAt, threadIsOpen } from "@/post/thread-view";
import { SUSPENDED_NOTE } from "@/moderation/suspension";
import { supabaseServer } from "@/lib/supabase/server";
import { sendMessage } from "./actions";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /post/[id]/thread — the message thread on a match (story #35 AC 2, AC 5).
 *
 * WHY THIS URL AND NOT /match/[id]/thread, which the issue filed (owner decision 2026-09-17).
 * There is no /match route in this app and never has been: a match is shown by MatchPanel on
 * /post/[id], `match.post_id` is unique so the two are one-to-one, and the match email already
 * links to the post. #33 hit the same filed-but-unbuilt route and resolved it the same way; its
 * notifyMatch docstring left the thread's URL to this story, and this is the answer.
 *
 * A THIRD SIGNED-IN PERSON GETS 404, NOT 403, and not an empty thread. 0020's read policy would
 * already hand them zero rows, so a page that rendered would show an empty conversation and
 * imply the thread exists — which tells them two people are matched and talking. `notFound()`
 * at the top level of this component, before anything streams, is what makes the status a real
 * 404: the check cannot sit inside a Suspense boundary, because the response has already begun
 * as a 200 by then.
 *
 * The party check is made here for the page and AGAIN by the database on every read, and the
 * send action makes it a third time — a Server Action is a POST endpoint anyone can call, so
 * what this page renders is not a boundary (Next 16's own security guidance).
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);

  // The match, the post's boat and the race date in one read, as the caller. No filter names an
  // embedded resource — every `.eq` here is on `post`'s own column — because a filter on an
  // embed is applied to the embed and leaves the parent with a null, which every generated type
  // says cannot happen (cairn: postgrest-filtering-on-an-embedded-resource).
  const { data: match } = await client
    .from("match")
    .select(
      "id, post_id, skipper_id, crew_id, accepted_at, post:post_id (boat:boat_id (name, class), race_date:race_date_id (starts_at, title))",
    )
    .eq("post_id", id)
    .maybeSingle();
  // No match on this post, or a match the caller cannot see: either way there is no thread here.
  // Except that an unpublished race day hides the match from its own two parties too (0008 reads
  // post under 0006's policy), and a message push lands here — so they are told the day was
  // withdrawn, and anyone else still gets "Not here" (#199, 0034).
  if (!match) {
    const withdrawn = await readWithdrawnDay(client, id);
    if (withdrawn) return <WithdrawnPost startsAt={withdrawn} />;
    notFound();
  }

  // A non-party is refused the thread even though 0008 lets them see the match itself — the
  // thread is not a view of the match, it is a private conversation inside it.
  const role = matchRole(match, user.id);
  if (role === "other") notFound();

  const post = (Array.isArray(match.post) ? match.post[0] : match.post) as {
    boat: { name: string; class: string } | { name: string; class: string }[];
    race_date: { starts_at: string; title: string } | { starts_at: string; title: string }[];
  } | null;
  if (!post) notFound();
  const boat = (Array.isArray(post.boat) ? post.boat[0] : post.boat) as { name: string; class: string };
  const date = (Array.isArray(post.race_date) ? post.race_date[0] : post.race_date) as {
    starts_at: string;
    title: string;
  };

  // Removed messages are READ and shown as removed (#36 AC 2): both parties see "Removed by the
  // club admin" where the message was, so the conversation keeps its shape and nobody wonders
  // whether the other person deleted something. The original is not in this row any more —
  // remove_message() (0023) moved it to the admin-only message_removal — and `messageText` renders
  // from `removed_at` regardless of what the body holds.
  //
  // THE `error` IS READ, NOT DISCARDED, and that is the point of the throw below. Destructuring
  // only `data` leaves `messages` undefined on a failed read, and this page would then render
  // `No messages yet.` with a working send box at HTTP 200 — both parties shown their entire
  // conversation apparently deleted, with nothing anywhere saying otherwise. The realistic
  // trigger is not exotic: a column-grant regression on any column NAMED here, including in the
  // `is()` and the `order()`, is refused with a message naming the table and not the column,
  // which is the shape that bit #29's push_subscription delete. An error page is the honest
  // answer, because "no messages" is a claim this page must only make when it is true.
  const { data: messages, error: messagesError } = await client
    .from("message")
    .select("id, author_id, body, created_at, removed_at")
    .eq("match_id", match.id)
    .order("created_at", { ascending: true });
  if (messagesError) throw new Error(`thread: read messages: ${messagesError.message}`);

  // The caller's own suspension row, if any (0023: self or admin). A suspended party still reads
  // the whole thread — suspension hides nothing — but gets the reason in place of the send box,
  // rather than a box whose every send the database refuses with a sentence about party rules.
  // A failed read is not fatal: the database still refuses the write, so the cost is the wrong
  // sentence on a refusal, not a message that should not exist.
  const { data: suspension, error: suspensionError } = await client
    .from("suspension")
    .select("suspended_at")
    .eq("person_id", user.id)
    .maybeSingle();
  if (suspensionError) console.error(`thread: read suspension: ${suspensionError.message}`);

  // Both parties' names, for the attribution line on each message. A failure here is NOT fatal:
  // the fallback is the word "someone" beside a message whose text is already correct, which is
  // a cosmetic loss rather than a false statement about the conversation.
  // A party who deleted their account (0027) is a null side: nothing to read, and `in` with a
  // null in the list is a PostgREST filter error rather than an empty match.
  const partyIds = [match.skipper_id, match.crew_id].filter((p): p is string => p !== null);
  const { data: people, error: peopleError } = await client.from("person").select("id, display_name").in("id", partyIds);
  if (peopleError) console.error(`thread: read names: ${peopleError.message}`);
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));

  const now = new Date();
  const otherId = role === "skipper" ? match.crew_id : match.skipper_id;
  // A thread whose other party has left is read-only whatever the date: there is nobody to
  // send to, and the message would sit in a conversation only one person can open.
  const open = otherId !== null && threadIsOpen(date.starts_at, now);
  const f = formatStartsAt(date.starts_at);
  const other = partyName(names, otherId, "your counterparty");

  return (
    <main>
      <p>
        <Link href={`/post/${id}`}>Back to the post</Link>
      </p>
      <h1>
        Messages — {boat.name}, {f.date}
      </h1>
      <p data-thread={match.id} data-open={open} data-role={role}>
        You and {otherId ? <Link href={`/profile/${otherId}`}>{other}</Link> : <span data-former-member>{other}</span>} on{" "}
        {boat.name} ({boat.class}), {date.title}, {whenLabel(date.starts_at)}.
      </p>

      <ol data-messages={messages?.length ?? 0} data-list>
        {(messages ?? []).map((m) => {
          const shown = messageText(m);
          return (
            <li
              key={m.id}
              data-message={m.id}
              data-mine={m.author_id === user.id}
              data-removed={shown.removed}
            >
              {/* A removed message has no control of any kind — no edit, no restore, no resend
                  (#36 AC 3); the database refuses its author every update regardless. */}
              <p data-body>{shown.text}</p>
              <p data-meta>
                {names.get(m.author_id) ?? "someone"} · {new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}
              </p>
            </li>
          );
        })}
      </ol>
      {(messages?.length ?? 0) === 0 && <p data-status="empty">No messages yet.</p>}

      {otherId === null ? (
        <p data-status="former-member" role="note">
          <strong>Closed.</strong> {FORMER_MEMBER.charAt(0).toUpperCase() + FORMER_MEMBER.slice(1)}: the person
          you were matched with has left the club. What was said stays here; nothing more can be sent.
        </p>
      ) : open && suspension ? (
        <p data-status="suspended" role="note">
          {SUSPENDED_NOTE}
        </p>
      ) : open ? (
        // The action is bound to the post id here rather than carried in a hidden input: a
        // hidden field is part of the rendered HTML and unencoded, and the action re-derives
        // everything security-relevant from the session and the row regardless.
        <SendMessageForm postId={id} action={sendMessage.bind(null, id)} />
      ) : (
        <p data-status="closed" role="note">
          <strong>Closed.</strong> {THREAD_CLOSED_NOTE} It closed on{" "}
          {formatStartsAt(threadClosesAt(date.starts_at).toISOString()).date}.
        </p>
      )}
    </main>
  );
}
