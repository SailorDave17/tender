import Link from "next/link";
import { redirect } from "next/navigation";
import { RATINGS } from "@/profile/profile";
import { explainPostRefusal } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { createBoat } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /boats — the signed-in person's boats (story #19 AC 2). Owning one is what makes them a
 * skipper: each boat here links to posting a need for it. The list is read as the person and
 * filtered to their own; every boat is readable by everyone (the board names them), so the
 * filter is the page's, not the policy's.
 */
export default async function BoatsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const [{ data: boats }, { data: classes }] = await Promise.all([
    client
      .from("boat")
      .select("id, name, class, default_minimum")
      .eq("owner_id", user.id)
      .order("created_at"),
    client.from("boat_class").select("name").order("name"),
  ]);
  const { error } = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Your boats</h1>
      <p>
        A boat is what you post a crew need for. <Link href="/board">Back to the board</Link>
      </p>

      {!boats?.length ? (
        <p data-boats="0">You have no boats yet.</p>
      ) : (
        <ul data-boats={boats.length} style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
          {boats.map((b) => (
            <li key={b.id} data-boat={b.id} style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ flex: 1 }}>
                <strong>{b.name}</strong> — {b.class}, usually takes{" "}
                {RATINGS.find((r) => r.value === b.default_minimum)?.label.toLowerCase()}
              </span>
              <Link href={`/post/new?boat=${b.id}`}>Post a crew need</Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Add a boat</h2>
      <form action={createBoat} style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          Name
          <input name="name" required maxLength={80} placeholder="Blue Moon" style={{ display: "block" }} />
        </label>
        <label>
          Class
          <select name="class" required defaultValue="" style={{ display: "block" }}>
            <option value="" disabled>
              Pick a class
            </option>
            {(classes ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset style={{ display: "grid", gap: "0.25rem" }}>
          <legend>Minimum competence you usually take</legend>
          {RATINGS.map((r) => (
            <label key={r.value}>
              <input type="radio" name="minimum" value={r.value} required /> {r.label}
            </label>
          ))}
        </fieldset>
        <button type="submit">Add boat</button>
      </form>
      {error && <p role="alert">{explainPostRefusal(error)}</p>}
    </main>
  );
}
