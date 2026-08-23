import { redirect } from "next/navigation";
import { ProfileCard } from "@/profile/ProfileCard";
import { RATINGS, explainProfileRefusal } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";
import { saveProfile } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /profile — the signed-in person's own profile: competence, hull willingness, optional phone
 * (story #18 AC 2). The proxy has already sent anyone with no session to /join. Everything is
 * read through RLS as the person, so the contact row that comes back is theirs and nobody
 * else's; /profile/[id] is how anyone else's profile reads, and it carries no phone.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const [{ data: me }, { data: contact }, { data: classes }] = await Promise.all([
    client
      .from("person")
      .select("id, display_name, rating, any_hull, hulls")
      .eq("id", user.id)
      .maybeSingle(),
    client.from("person_contact").select("phone").eq("person_id", user.id).maybeSingle(),
    client.from("boat_class").select("name").order("name"),
  ]);
  if (!me) redirect("/join?error=not-invited");
  const { error, saved } = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Your profile</h1>
      <p>
        Skippers and the ladder go by this. <a href="/board">Back to the board</a>
      </p>

      <ProfileCard person={me} phone={contact?.phone ?? null} viewerId={user.id} />

      <form action={saveProfile} style={{ display: "grid", gap: "1rem", marginTop: "1.5rem" }}>
        <fieldset style={{ display: "grid", gap: "0.25rem" }}>
          <legend>How competent are you?</legend>
          {RATINGS.map((r) => (
            <label key={r.value}>
              <input type="radio" name="rating" value={r.value} defaultChecked={me.rating === r.value} required />{" "}
              {r.label}
            </label>
          ))}
        </fieldset>

        <fieldset style={{ display: "grid", gap: "0.25rem" }}>
          <legend>Which hulls will you sail?</legend>
          <label>
            <input type="radio" name="hulls" value="any" defaultChecked={me.any_hull} /> Any hull
          </label>
          <label>
            <input type="radio" name="hulls" value="some" defaultChecked={!me.any_hull} /> Only these:
          </label>
          <div style={{ display: "grid", gap: "0.25rem", paddingLeft: "1.5rem" }}>
            {(classes ?? []).map((c) => (
              <label key={c.name}>
                <input type="checkbox" name="classes" value={c.name} defaultChecked={me.hulls.includes(c.name)} />{" "}
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>

        <label>
          Phone (optional — shown to a skipper only once you are matched)
          <input
            name="phone"
            type="tel"
            autoComplete="tel"
            maxLength={24}
            defaultValue={contact?.phone ?? ""}
            style={{ display: "block" }}
          />
        </label>

        <button type="submit">Save profile</button>
      </form>
      {error && <p role="alert">{explainProfileRefusal(error)}</p>}
      {saved && !error && <p role="status">Saved.</p>}
    </main>
  );
}
