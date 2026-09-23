import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { threadsByActivity, type ThreadMatch, type ThreadMessage } from "@/admin/threads";
import { formatStartsAt } from "@/dates/race-date";
import { partyName } from "@/post/match-view";
import { supabaseServer } from "@/lib/supabase/server";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /admin/threads — every match thread, by last activity (story #36 AC 1).
 *
 * The charter calls the match thread "the one surface where two people who have never met talk",
 * and this is the admin's way into it. Signed-in non-admins get a 404, as on every /admin page —
 * and the database decides again: the admin reads other people's messages only through 0023's
 * `message_read_admin`, so a non-admin who reached this code would see their own threads at most.
 *
 * Every read's `error` is read. A failed message read rendered as a list of silent threads would
 * tell the admin nothing has been said anywhere, which is the one false statement this screen
 * must not make.
 */
export default async function AdminThreadsPage() {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const [matchRead, messageRead, peopleRead] = await Promise.all([
    client
      .from("match")
      .select(
        "id, post_id, skipper_id, crew_id, accepted_at, post:post_id (boat:boat_id (name), race_date:race_date_id (starts_at, title))",
      ),
    client.from("message").select("match_id, created_at, removed_at"),
    client.from("person").select("id, display_name"),
  ]);
  if (matchRead.error) throw new Error(`admin threads: read matches: ${matchRead.error.message}`);
  if (messageRead.error) throw new Error(`admin threads: read messages: ${messageRead.error.message}`);

  type Row = ThreadMatch & {
    post:
      | { boat: { name: string } | { name: string }[]; race_date: { starts_at: string; title: string } | { starts_at: string; title: string }[] }
      | { boat: { name: string } | { name: string }[]; race_date: { starts_at: string; title: string } | { starts_at: string; title: string }[] }[]
      | null;
  };
  const rows = (matchRead.data ?? []) as Row[];
  const detail = new Map(
    rows.map((r) => {
      const post = Array.isArray(r.post) ? r.post[0] : r.post;
      const boat = post ? (Array.isArray(post.boat) ? post.boat[0] : post.boat) : null;
      const date = post ? (Array.isArray(post.race_date) ? post.race_date[0] : post.race_date) : null;
      return [r.id, { boat: boat?.name ?? "a boat", date }];
    }),
  );
  const names = new Map(((peopleRead.data ?? []) as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name]));
  const threads = threadsByActivity(rows, (messageRead.data ?? []) as ThreadMessage[]);

  return (
    <main data-measure="wide">
      <h1>Match threads</h1>
      <p>
        <Link href="/admin">Back to admin</Link>
      </p>
      <p>
        Every match has a thread between its skipper and crew. You can read any of them and remove
        a message; neither party can see that you have looked.
      </p>

      {threads.length === 0 ? (
        <p data-status="empty">No matches yet, so no threads.</p>
      ) : (
        <ol data-threads={threads.length} style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.75rem" }}>
          {threads.map((t) => {
            const d = detail.get(t.id);
            const when = new Date(t.lastActivity).toLocaleString("en-US", {
              timeZone: "America/New_York",
              dateStyle: "medium",
              timeStyle: "short",
            });
            return (
              <li key={t.id} data-thread={t.id} data-messages={t.messages} data-removed={t.removed}>
                <Link href={`/admin/threads/${t.id}`}>
                  <strong>{d?.boat}</strong>
                  {d?.date ? ` — ${formatStartsAt(d.date.starts_at).date}, ${d.date.title}` : ""}
                </Link>
                <br />
                <small>
                  {partyName(names, t.skipper_id, "skipper")} and {partyName(names, t.crew_id, "crew")} ·{" "}
                  {t.messages === 0 ? "no messages" : t.messages === 1 ? "1 message" : `${t.messages} messages`}
                  {t.removed > 0 && ` (${t.removed} removed)`} · {t.messages === 0 ? "matched" : "last"} {when}
                </small>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
