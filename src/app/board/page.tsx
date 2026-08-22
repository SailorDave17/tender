import Link from "next/link";
import { explainAvailabilityRefusal, isPast, summarise } from "@/availability/rules";
import { formatStartsAt } from "@/dates/race-date";
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
  const [{ data: me }, { data: dates }, { data: availability }] = await Promise.all([
    user
      ? client.from("person").select("display_name, is_admin, rating").eq("id", user.id).maybeSingle()
      : Promise.resolve({ data: null }),
    client.from("race_date").select("id, starts_at, title").eq("published", true).order("starts_at"),
    client.from("availability").select("person_id, race_date_id"),
  ]);
  const { error } = await searchParams;
  const now = new Date();
  const unrated = !me || me.rating == null;
  const byDate = summarise(availability ?? [], user?.id ?? "");

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
      {error && <p role="alert">{explainAvailabilityRefusal(error)}</p>}

      <h2>Race days</h2>
      {!dates?.length ? (
        <p>The season has no dates yet.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {dates.map((d) => {
            const f = formatStartsAt(d.starts_at);
            const s = byDate.get(d.id) ?? { count: 0, mine: false };
            const past = isPast(d.starts_at, now);
            return (
              <li
                key={d.id}
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
              </li>
            );
          })}
        </ol>
      )}
      {me?.is_admin && (
        <p>
          <a href="/admin/dates">Edit race dates</a>
        </p>
      )}

      <p>Posts arrive with the next story.</p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
