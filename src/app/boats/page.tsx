import Link from "next/link";
import { redirect } from "next/navigation";
import { RATINGS } from "@/profile/profile";
import { explainPostRefusal } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { createBoat } from "./actions";
import { SIGN_IN_URL } from "@/auth/gate";

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
  if (!user) redirect(SIGN_IN_URL);

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
    <main>
      <h1>Your boats</h1>
      <p>
        A boat is what you post a crew need for. <Link href="/board">Back to the board</Link>
      </p>

      {!boats?.length ? (
        <p data-boats="0">You have no boats yet.</p>
      ) : (
        <ul data-boats={boats.length} data-list="stack">
          {boats.map((b) => (
            <li key={b.id} data-boat={b.id} data-row>
              <span data-grow>
                <strong>{b.name}</strong> — {b.class}, usually takes{" "}
                {RATINGS.find((r) => r.value === b.default_minimum)?.label.toLowerCase()}
              </span>
              <Link href={`/post/new?boat=${b.id}`}>Post a crew need</Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Add a boat</h2>
      <form action={createBoat} data-stack>
        <label>
          Name
          <input name="name" required maxLength={80} placeholder="Blue Moon" />
        </label>
        <label>
          Class
          <select name="class" required defaultValue="">
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
        <fieldset>
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
