import { formatStartsAt } from "@/dates/race-date";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The board. The proxy sends anyone without a session to /join before this renders; the
 * person's own row and the season's dates are read through RLS as them.
 *
 * Published dates only, and the filter is stated here rather than left to the policy: 0004
 * lets an admin read unpublished rows (so the admin list can show them), and the board must
 * not — an admin looking at the board sees what a crew sees (story #17 AC 3).
 */
export default async function BoardPage() {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  const { data: me } = user
    ? await client.from("person").select("display_name, is_admin").eq("id", user.id).maybeSingle()
    : { data: null };
  const { data: dates } = await client
    .from("race_date")
    .select("id, starts_at, title")
    .eq("published", true)
    .order("starts_at");

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Tender</h1>
      <p>Signed in as {me?.display_name ?? user?.email ?? "someone"}.</p>

      <h2>Race days</h2>
      {!dates?.length ? (
        <p>The season has no dates yet.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {dates.map((d) => {
            const f = formatStartsAt(d.starts_at);
            return (
              <li key={d.id}>
                <strong>{f.date}</strong> {f.time} — {d.title}
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

      <p>Posts and crew arrive with the next stories.</p>
      <form action="/auth/signout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
