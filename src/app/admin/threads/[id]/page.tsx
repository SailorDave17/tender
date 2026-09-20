import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatStartsAt } from "@/dates/race-date";
import { partyName } from "@/post/match-view";
import { UUID } from "@/post/post-form";
import { messageText } from "@/post/thread-view";
import { supabaseServer } from "@/lib/supabase/server";
import { removeMessage } from "../actions";

export const dynamic = "force-dynamic";

/**
 * /admin/threads/[id] — one match's thread, read-only, as the admin (story #36 AC 1, AC 2).
 * `[id]` is the MATCH id: the parties reach the same thread at /post/[id]/thread because that is
 * where they see their match, but the admin arrives from a list of matches.
 *
 * READ-ONLY means no send box. The admin's reads come through 0023's `message_read_admin`; the
 * write policy is still 0020's party rule, so an admin who is not a party could not post here
 * even through a crafted request (moderation.test.ts proves it).
 *
 * REMOVE IS TWO TAPS, the same shape as /admin's invite-code rotation: a GET that shows the
 * confirmation (?confirm=<message id>), then the POST. A removal cannot be undone from any screen
 * — the original moves to `message_removal` and nothing puts it back — so a mis-tap on the wrong
 * message of a long thread must cost a second tap rather than someone's words.
 *
 * The admin sees a removed message's ORIGINAL beneath the notice, from `message_removal`, which
 * only the admin can read. That is the audit half of the owner's decision to move the body out
 * rather than hide it: the parties lose it, the club's record keeps it.
 */
export default async function AdminThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirm?: string; removed?: string; error?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const { data: match } = await client
    .from("match")
    .select(
      "id, post_id, skipper_id, crew_id, post:post_id (boat:boat_id (name, class), race_date:race_date_id (starts_at, title))",
    )
    .eq("id", id)
    .maybeSingle();
  if (!match) notFound();

  const post = (Array.isArray(match.post) ? match.post[0] : match.post) as {
    boat: { name: string; class: string } | { name: string; class: string }[];
    race_date: { starts_at: string; title: string } | { starts_at: string; title: string }[];
  } | null;
  const boat = post ? ((Array.isArray(post.boat) ? post.boat[0] : post.boat) as { name: string; class: string }) : null;
  const date = post
    ? ((Array.isArray(post.race_date) ? post.race_date[0] : post.race_date) as { starts_at: string; title: string })
    : null;

  // As on the parties' page, a failed read is an error page and never "No messages yet".
  const { data: messages, error: messagesError } = await client
    .from("message")
    .select("id, author_id, body, created_at, removed_at")
    .eq("match_id", match.id)
    .order("created_at", { ascending: true });
  if (messagesError) throw new Error(`admin thread: read messages: ${messagesError.message}`);

  const removedIds = (messages ?? []).filter((m) => m.removed_at).map((m) => m.id);
  const { data: originals, error: originalsError } = removedIds.length
    ? await client.from("message_removal").select("message_id, body").in("message_id", removedIds)
    : { data: [], error: null };
  if (originalsError) console.error(`admin thread: read originals: ${originalsError.message}`);
  const original = new Map(((originals ?? []) as { message_id: string; body: string }[]).map((o) => [o.message_id, o.body]));

  // A null side is a party who deleted their account (0027) — filtered out of the `in`, and
  // printed as "former member" below.
  const partyIds = [match.skipper_id, match.crew_id].filter((p): p is string => p !== null);
  const { data: people } = await client.from("person").select("id, display_name").in("id", partyIds);
  const names = new Map((people ?? []).map((p) => [p.id, p.display_name]));

  const { confirm, removed, error } = await searchParams;
  const remove = removeMessage.bind(null, match.id);

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "36rem" }}>
      <p>
        <Link href="/admin/threads">All threads</Link>
      </p>
      <h1>
        Thread — {boat?.name ?? "a boat"}
        {date ? `, ${formatStartsAt(date.starts_at).date}` : ""}
      </h1>
      <p data-thread={match.id} data-read-only>
        {partyName(names, match.skipper_id, "The skipper")} (skipper) and {partyName(names, match.crew_id, "the crew")} (crew)
        {date ? ` for ${date.title}` : ""}. Read-only: you can remove a message, not write one.
      </p>
      {removed && <p role="status">The message was removed. Both of them now see &ldquo;Removed by the club admin&rdquo; in its place.</p>}
      {error && <p role="alert">The message was not removed: the database refused it.</p>}

      <ol data-messages={messages?.length ?? 0} style={{ listStyle: "none", padding: 0 }}>
        {(messages ?? []).map((m) => {
          const shown = messageText(m);
          return (
            <li
              key={m.id}
              data-message={m.id}
              data-removed={shown.removed}
              style={{ margin: "0.75rem 0", padding: "0.5rem 0.75rem", background: "#f5f5f5", borderRadius: "0.5rem" }}
            >
              <p style={{ margin: 0, whiteSpace: "pre-wrap", fontStyle: shown.removed ? "italic" : undefined }}>{shown.text}</p>
              {shown.removed && original.has(m.id) && (
                <details style={{ marginTop: "0.25rem" }}>
                  <summary>Original (only you can see this)</summary>
                  <p data-original style={{ margin: "0.25rem 0 0", whiteSpace: "pre-wrap" }}>{original.get(m.id)}</p>
                </details>
              )}
              <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "#555" }}>
                {names.get(m.author_id) ?? "someone"} ·{" "}
                {new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })}
              </p>
              {!shown.removed &&
                (confirm === m.id ? (
                  <form action={remove} style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", marginTop: "0.5rem" }}>
                    <input type="hidden" name="message_id" value={m.id} />
                    <strong>Remove this message?</strong>
                    <button type="submit" data-confirm-remove={m.id}>
                      Yes, remove it
                    </button>
                    <Link href={`/admin/threads/${match.id}`}>Cancel</Link>
                  </form>
                ) : (
                  <form method="get" action={`/admin/threads/${match.id}`} style={{ marginTop: "0.5rem" }}>
                    <input type="hidden" name="confirm" value={m.id} />
                    <button type="submit" data-remove={m.id}>
                      Remove
                    </button>
                  </form>
                ))}
            </li>
          );
        })}
      </ol>
      {(messages?.length ?? 0) === 0 && <p data-status="empty">No messages in this thread yet.</p>}
    </main>
  );
}
