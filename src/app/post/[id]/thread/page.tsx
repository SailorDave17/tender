import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatStartsAt, whenLabel } from "@/dates/race-date";
import { matchRole } from "@/post/match-view";
import { UUID } from "@/post/post-form";
import { SendMessageForm } from "@/post/SendMessageForm";
import { THREAD_CLOSED_NOTE, threadClosesAt, threadIsOpen } from "@/post/thread-view";
import { supabaseServer } from "@/lib/supabase/server";
import { sendMessage } from "./actions";

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
  if (!user) redirect("/join");

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
  if (!match) notFound();

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

  // Removed messages are filtered out rather than shown as removed: the moderation story owns
  // what a removed message looks like, and until it ships the honest rendering is absence.
  const { data: messages } = await client
    .from("message")
    .select("id, author_id, body, created_at")
    .eq("match_id", match.id)
    .is("removed_at", null)
    .order("created_at", { ascending: true });

  // Both parties' names, for the attribution line on each message.
  const { data: people } = await client
    .from("person")
    .select("id, display_name")
    .in("id", [match.skipper_id, match.crew_id]);
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));

  const now = new Date();
  const open = threadIsOpen(date.starts_at, now);
  const f = formatStartsAt(date.starts_at);
  const otherId = role === "skipper" ? match.crew_id : match.skipper_id;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <p>
        <Link href={`/post/${id}`}>Back to the post</Link>
      </p>
      <h1>
        Messages — {boat.name}, {f.date}
      </h1>
      <p data-thread={match.id} data-open={open} data-role={role}>
        You and <Link href={`/profile/${otherId}`}>{names.get(otherId) ?? "your counterparty"}</Link> on{" "}
        {boat.name} ({boat.class}), {date.title}, {whenLabel(date.starts_at)}.
      </p>

      <ol data-messages={messages?.length ?? 0} style={{ listStyle: "none", padding: 0 }}>
        {(messages ?? []).map((m) => (
          <li
            key={m.id}
            data-message={m.id}
            data-mine={m.author_id === user.id}
            style={{ margin: "0.75rem 0", padding: "0.5rem 0.75rem", background: m.author_id === user.id ? "#eef3fb" : "#f5f5f5", borderRadius: "0.5rem" }}
          >
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{m.body}</p>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "#555" }}>
              {names.get(m.author_id) ?? "someone"} · {new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}
            </p>
          </li>
        ))}
      </ol>
      {(messages?.length ?? 0) === 0 && <p data-status="empty">No messages yet.</p>}

      {open ? (
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
