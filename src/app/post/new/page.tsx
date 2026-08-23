import Link from "next/link";
import { redirect } from "next/navigation";
import { isPast } from "@/availability/rules";
import { formatStartsAt } from "@/dates/race-date";
import { RATINGS } from "@/profile/profile";
import { UUID, explainPostRefusal } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { createPost } from "../actions";

export const dynamic = "force-dynamic";

/**
 * /post/new — post a crew need (story #19 AC 2). The boat is chosen first, as `?boat=<id>`
 * from /boats, so the form can default the minimum from that boat with no client JavaScript;
 * with no boat chosen the page lists the person's boats to pick from. Dates offered are the
 * published ones that have not started — the same set 0006's insert policy admits, so the
 * form never offers a day the database would refuse.
 */
export default async function NewPostPage({
  searchParams,
}: {
  searchParams: Promise<{ boat?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { boat: boatParam, error } = await searchParams;

  const [{ data: boats }, { data: dates }] = await Promise.all([
    client.from("boat").select("id, name, class, default_minimum").eq("owner_id", user.id).order("created_at"),
    client.from("race_date").select("id, starts_at, title").eq("published", true).order("starts_at"),
  ]);
  const now = new Date();
  const open = (dates ?? []).filter((d) => !isPast(d.starts_at, now));
  const boat = boatParam && UUID.test(boatParam) ? (boats ?? []).find((b) => b.id === boatParam) : undefined;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Post a crew need</h1>
      <p>
        <Link href="/board">Back to the board</Link>
      </p>

      {!boats?.length ? (
        <p data-no-boats>
          You need a boat first. <Link href="/boats">Add one</Link>.
        </p>
      ) : !boat ? (
        <>
          <h2>Which boat?</h2>
          <ul data-pick-boat>
            {boats.map((b) => (
              <li key={b.id}>
                <Link href={`/post/new?boat=${b.id}`}>
                  {b.name} — {b.class}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : open.length === 0 ? (
        <p data-no-dates>There is no upcoming race day to post against.</p>
      ) : (
        <form action={createPost} style={{ display: "grid", gap: "0.75rem" }}>
          <input type="hidden" name="boat_id" value={boat.id} />
          <p>
            <strong>{boat.name}</strong> — {boat.class} (<Link href="/post/new">change boat</Link>)
          </p>
          <label>
            Race day
            <select name="race_date_id" required defaultValue="" style={{ display: "block" }}>
              <option value="" disabled>
                Pick a race day
              </option>
              {open.map((d) => {
                const f = formatStartsAt(d.starts_at);
                return (
                  <option key={d.id} value={d.id}>
                    {f.date} {f.time} — {d.title}
                  </option>
                );
              })}
            </select>
          </label>
          <fieldset style={{ display: "grid", gap: "0.25rem" }}>
            <legend>Minimum competence for this day</legend>
            {RATINGS.map((r) => (
              <label key={r.value}>
                <input type="radio" name="minimum" value={r.value} defaultChecked={r.value === boat.default_minimum} required />{" "}
                {r.label}
              </label>
            ))}
          </fieldset>
          <label>
            Note (optional)
            <textarea name="note" maxLength={280} rows={3} placeholder="Jib trimmer wanted; we launch at noon" style={{ display: "block", width: "100%" }} />
          </label>
          <button type="submit">Post it</button>
        </form>
      )}
      {error && <p role="alert">{explainPostRefusal(error)}</p>}
    </main>
  );
}
