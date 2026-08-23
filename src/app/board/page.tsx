import Link from "next/link";
import { explainAvailabilityRefusal, isPast, summarise } from "@/availability/rules";
import { loadBoardData } from "@/board/load";
import { poolForDate, viewPost } from "@/board/post-view";
import { formatStartsAt } from "@/dates/race-date";
import { RungBadge } from "@/post/CandidateList";
import { explainPostRefusal } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { setAvailability } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The board. The proxy sends anyone without a session to /join before this renders; the
 * person's own row, the season's dates and everyone's availability are read through RLS as
 * them.
 *
 * Published dates only, and the filter is stated here rather than left to the policy: 0004
 * lets an admin read unpublished rows (so the admin list can show them), and the board must
 * not — an admin looking at the board sees what a crew sees (story #17 AC 3).
 *
 * Each date carries the count of crew who can sail it and the person's own toggle (story #18
 * AC 4). A person with no rating is sent to /profile first and the toggles are withheld
 * (AC 5); a date already started is shown but its toggle disabled. Both rules are applied
 * again in the Server Action, and the first in the database.
 *
 * Under each date, every open post for it with its rung (story #19 AC 3) and how many have
 * answered it (story #20 — the count is all a non-skipper may know, 0007), and every matched
 * post as 'Crewed' with both names and no rung — a crewed boat is news, a closed need is not
 * (story #21 AC 5; a post closed by hand with no match stays off the board). THE RUNG IS
 * COMPUTED ON THIS READ — suggest() over the crew available for the date, through
 * post-view.ts — which is ADR 004's lazy-relaxation fallback shipped first; the persisted,
 * monotone rung arrives with the notification ledger (#23/#25). Until then two reads of the
 * board can disagree about a rung, in either direction, and that is by design.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  const [{ data: me }, data] = await Promise.all([
    user
      ? client.from("person").select("display_name, is_admin, rating").eq("id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadBoardData(client),
  ]);
  const { dates, availability } = data;
  const { error } = await searchParams;
  const now = new Date();
  const unrated = !me || me.rating == null;
  const byDate = summarise(availability, user?.id ?? "");
  // Open posts, and matched ones (closed by the acceptance, shown as crewed).
  const boardPosts = data.posts.filter((p) => p.closed_at === null || data.matches.has(p.id));

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Tender</h1>
      <p>
        Signed in as {me?.display_name ?? user?.email ?? "someone"}. <Link href="/profile">Your profile</Link>
      </p>

      {unrated && (
        <p role="status" data-banner="no-rating" style={{ padding: "0.75rem", border: "1px solid currentColor" }}>
          Before you can mark the days you can sail, <Link href="/profile">set your competence on your profile</Link>.
        </p>
      )}
      {error && <p role="alert">{error === "refused" ? explainPostRefusal(error) : explainAvailabilityRefusal(error)}</p>}
      <p>
        <Link href="/boats">Your boats</Link> · <Link href="/post/new">Post a crew need</Link>
      </p>

      <h2>Race days</h2>
      {!dates?.length ? (
        <p>The season has no dates yet.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {dates.map((d) => {
            const f = formatStartsAt(d.starts_at);
            const s = byDate.get(d.id) ?? { count: 0, mine: false };
            const past = isPast(d.starts_at, now);
            const posts = boardPosts.filter((p) => p.race_date_id === d.id);
            const pool = poolForDate([...data.people.values()], availability, d.id);
            return (
              <li
                key={d.id}
                id={d.id}
                data-race-date={d.id}
                data-past={past}
                data-available={s.mine}
                style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", flexWrap: "wrap" }}
              >
                <span style={{ flex: 1 }}>
                  <strong>{f.date}</strong> {f.time} — {d.title}
                  <br />
                  <small data-available-count={s.count}>
                    {s.count === 0 ? "Nobody yet" : s.count === 1 ? "1 crew can sail" : `${s.count} crew can sail`}
                    {s.mine && " — including you"}
                  </small>
                </span>
                {!unrated && (
                  <form action={setAvailability}>
                    <input type="hidden" name="race_date_id" value={d.id} />
                    <input type="hidden" name="available" value={s.mine ? "false" : "true"} />
                    <button type="submit" disabled={past} aria-pressed={s.mine}>
                      {past ? "Already sailed" : s.mine ? "I can't make it after all" : "I can sail this day"}
                    </button>
                  </form>
                )}
                {posts.length > 0 && (
                  <ul data-posts={posts.length} style={{ flexBasis: "100%", listStyle: "none", padding: "0 0 0 1rem", margin: 0, display: "grid", gap: "0.35rem" }}>
                    {posts.map((p) => {
                      const boat = data.boats.get(p.boat_id);
                      if (!boat) return null;
                      const m = data.matches.get(p.id);
                      if (m) {
                        const skipper = data.people.get(m.skipper_id)?.display_name ?? "the skipper";
                        const crew = data.people.get(m.crew_id)?.display_name ?? "the crew";
                        return (
                          <li key={p.id} data-post={p.id} data-matched="true">
                            <strong>Crewed</strong> —{" "}
                            <Link href={`/post/${p.id}`}>
                              {boat.name} ({boat.class})
                            </Link>
                            : {skipper} with {crew}
                          </li>
                        );
                      }
                      const v = viewPost({ starts_at: d.starts_at, boatClass: boat.class, minimum: p.minimum, current_rung: p.current_rung }, pool, now);
                      const answered = data.answerCounts.get(p.id) ?? 0;
                      return (
                        <li key={p.id} data-post={p.id} data-rung={v.rung} data-candidates={v.candidateCount} data-answered={answered}>
                          <RungBadge rung={v.rung} colour={v.colour} />{" "}
                          <Link href={`/post/${p.id}`}>
                            <strong>{boat.name}</strong> ({boat.class}) needs crew
                          </Link>{" "}
                          — {v.candidateCount} {v.candidateCount === 1 ? "candidate" : "candidates"}
                          {answered > 0 && `, ${answered} answered`}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {me?.is_admin && (
        <p>
          <a href="/admin">Admin</a> · <a href="/admin/dates">Edit race dates</a>
        </p>
      )}

      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
