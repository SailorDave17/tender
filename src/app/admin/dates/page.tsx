import { redirect } from "next/navigation";
import { explainRefusal, formatStartsAt } from "@/dates/race-date";
import { supabaseServer } from "@/lib/supabase/server";
import { createRaceDate, setPublished } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /admin/dates — the season's race dates, entered by hand with a start time (story #17).
 *
 * The proxy has already sent anyone with no session to /join. A signed-in non-admin is sent to
 * the board: the page is not a secret, but its forms would only ever be refused by the database,
 * and a screen whose every button fails is worse than none. The list is read as the admin, so
 * 0004's policy returns unpublished rows too — that is what the Publish toggle is for.
 */
export default async function AdminDatesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client
    .from("person")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.is_admin) redirect("/board");

  const { data: dates, error: readError } = await client
    .from("race_date")
    .select("id, starts_at, title, published")
    .order("starts_at");
  const { error } = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Race dates</h1>
      <p>
        Every race day needs a start time — the ladder counts down to it. Dates are shown on the
        board only once published. <a href="/board">Back to the board</a>
      </p>

      <form action={createRaceDate} style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          Date
          <input name="date" type="date" required />
        </label>
        <label>
          Start time (club local)
          <input name="time" type="time" required />
        </label>
        <label>
          Title
          <input name="title" required maxLength={80} placeholder="Spring series 1" />
        </label>
        <button type="submit">Add race date</button>
      </form>
      {error && <p role="alert">{explainRefusal(error)}</p>}
      {readError && <p role="alert">Could not read the race dates: {readError.message}</p>}

      <h2>This season</h2>
      {!dates?.length ? (
        <p>No race dates entered yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {dates.map((d) => {
            const f = formatStartsAt(d.starts_at);
            return (
              <li
                key={d.id}
                data-published={d.published}
                style={{ display: "flex", gap: "0.75rem", alignItems: "baseline" }}
              >
                <span style={{ flex: 1 }}>
                  <strong>{f.date}</strong> {f.time} — {d.title}
                  {!d.published && <em> (not yet on the board)</em>}
                </span>
                <form action={setPublished}>
                  <input type="hidden" name="id" value={d.id} />
                  <input type="hidden" name="published" value={d.published ? "false" : "true"} />
                  <button type="submit">{d.published ? "Unpublish" : "Publish"}</button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
