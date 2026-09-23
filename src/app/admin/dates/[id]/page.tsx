import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadSeasonData } from "@/admin/load";
import { raceDayRows } from "@/admin/season";
import { formatStartsAt } from "@/dates/race-date";
import { RUNG_COLOUR } from "@/board/post-view";
import { statusLabel } from "@/post/match-view";
import { UUID } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /admin/dates/[id] — one race day, every post on it (story #38 AC 1).
 *
 * The admin's answer to "what happened that Saturday": boat and class, the skipper, the minimum
 * the post asked for, the final rung the ladder reached, who took it or that nobody did, and how
 * the match ended. It is the screen that replaces opening a SQL client, which is the story's
 * whole premise.
 *
 * Read-only by construction — there is no form on this page and no action imported. A mistake
 * here costs a wrong number on a screen, never a wrong row.
 *
 * ## The 404 is the ONLY gate on this screen, and that is worth stating plainly
 *
 * A signed-in non-admin gets **404**, not 403: the page exists for one person and to everyone
 * else it does not exist, which is `/admin`'s convention and `/admin/people`'s.
 *
 * Unlike `/admin`'s invite code — where `current_invite_code()` refuses a non-admin with 42501
 * and the database decides twice what the 404 decided once — **there is no second refusal here**.
 * `post_read_published` (0006), `match_read_with_post` (0008) and `person`'s read policy (0002)
 * are all member-wide by design, so a crew running this page's queries gets exactly the rows an
 * admin gets. Measured, in both directions, in `test/admin-season.test.ts`.
 *
 * That is defensible and it is deliberate: every figure on this screen is an aggregate of what
 * the club already publishes to its members on the board and on each post's page. Nothing here
 * is a secret the way the invite code is. But it means this page is protected by one mechanism
 * rather than two, and anyone adding a column to it that ISN'T already club-visible — an email,
 * a phone, a `reminded_at` — must add the database's refusal at the same time, because the 404
 * will not carry it alone.
 *
 * The date itself is looked up in the loaded list rather than fetched by id, so an id that is not
 * a published race date 404s here for the same reason a non-admin does — there is nothing to show
 * and no way to distinguish "no such date" from "not published" without leaking which.
 */
export default async function AdminRaceDayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const data = await loadSeasonData(client);
  const date = data.dates.find((d) => d.id === id);
  if (!date) notFound();

  const rows = raceDayRows(id, data.posts, data.matches, data.boats, data.people);
  const when = formatStartsAt(date.starts_at);
  const open = rows.filter((r) => r.open).length;

  return (
    <main data-measure="wide">
      <h1>{date.title}</h1>
      <p>
        <strong>{when.date}</strong> · starts {when.time}
      </p>
      <p>
        {/* /admin/dates has a dynamic child (this page), so Next requires <Link> here. */}
        <a href="/admin">Back to admin</a> · <Link href="/admin/dates">Race dates</Link> ·{" "}
        <a href="/board">The board</a>
      </p>

      {rows.length === 0 ? (
        <p data-no-posts>No boat posted for this race day.</p>
      ) : (
        <>
          <p>
            <strong data-post-count>{rows.length}</strong>{" "}
            {rows.length === 1 ? "boat posted" : "boats posted"}, <strong data-open-count>{open}</strong>{" "}
            still without crew.
          </p>

          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["Boat", "Class", "Skipper", "Minimum", "Final rung", "Crew", "Status"].map((h) => (
                  <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "0.25rem 0.5rem 0.25rem 0" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const colour = RUNG_COLOUR[r.finalRung];
                return (
                  <tr key={r.postId} data-post={r.postId} data-open={r.open}>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>
                      <a href={`/post/${r.postId}`}>{r.boatName}</a>
                    </td>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>{r.boatClass}</td>
                    {/* A skipper whose person row is gone is still a boat that was posted. */}
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>{r.skipper ?? "(removed)"}</td>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>{r.minimum}</td>
                    {/* The stored rung (0010), never one derived from the clock — src/admin/season.ts. */}
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-rung={r.finalRung}>
                      <span style={{ color: colour.hex }}>
                        {r.finalRung} · {colour.name}
                      </span>
                    </td>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-crew={r.open ? "open" : "matched"}>
                      {/* Three states, not two: open, matched to someone named, matched to
                          someone no longer readable. Collapsing the third into "open" would
                          erase a boat that did sail. */}
                      {r.open ? <em>open</em> : (r.crew ?? "(removed)")}
                    </td>
                    <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-match-status={r.status ?? "none"}>
                      {r.status === null ? "—" : (statusLabel(r.status) || "Matched")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p style={{ fontSize: "0.875rem", marginTop: "1.5rem" }}>
            <strong>Final rung</strong> is the widest rung the ladder actually opened and emailed
            for that post — rung 1 is the strict match, 3 is everyone available. A boat that filled
            at rung 1 found crew without the ladder having to relax, which is the outcome the club
            is aiming for.
          </p>
        </>
      )}
    </main>
  );
}
