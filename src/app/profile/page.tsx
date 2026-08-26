import { redirect } from "next/navigation";
import { explainLinkReason, hasGoogleIdentity } from "@/auth/link";
import { PushToggle } from "@/push/PushToggle";
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
  searchParams: Promise<{ error?: string; saved?: string; linked?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const [{ data: me }, { data: contact }, { data: classes }, { data: devices }] = await Promise.all([
    client
      .from("person")
      .select("id, display_name, rating, any_hull, hulls")
      .eq("id", user.id)
      .maybeSingle(),
    client.from("person_contact").select("phone").eq("person_id", user.id).maybeSingle(),
    client.from("boat_class").select("name").order("name"),
    // 0013's read policy is self-only, so this is the caller's own devices and cannot be
    // anyone else's. The keys are withheld at the grant — the page has no use for them.
    client.from("push_subscription").select("id").eq("person_id", user.id),
  ]);
  if (!me) redirect("/join?error=not-invited");
  const { error, saved, linked } = await searchParams;
  // Read on the server and handed down: NEXT_PUBLIC_ is inlined at build time, so a client
  // component reading it directly would bake in whatever the BUILDING machine had rather than
  // what this deployment holds (cairn: nextjs-proxy-inlines-public-env-at-build).
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  // `user.identities` comes back on the same getUser() call the page already made, so knowing
  // whether Google is linked costs nothing. It is optional in the client's own User type, so an
  // absent list reads as "not linked" — the safe direction: the member still sees the control,
  // and GoTrue refuses a second link with `identity_already_exists`, which the page explains.
  const googleLinked = hasGoogleIdentity(user.identities);

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

      {/*
        #29: web push is ADR 007's bet, and this is the only place a crew can take it. The
        control is rendered only where a key exists to subscribe with — a deployment with no
        VAPID key would otherwise show a button that can only fail, and the honest thing is to
        show nothing rather than a promise the server cannot keep.
      */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Notifications</h2>
        {vapidPublicKey ? (
          <PushToggle vapidPublicKey={vapidPublicKey} subscribed={(devices ?? []).length > 0} />
        ) : (
          <p>Push notifications are not set up for this club yet. You will still be emailed.</p>
        )}
        <p style={{ fontSize: "0.875rem" }}>
          On an iPhone, add Tender to your home screen first — Apple only offers notifications to a
          web app that has been installed.
        </p>
      </section>

      {/*
        #74: a member whose Google address differs from the one they joined with is a stranger to
        Supabase, which links a Google identity to an existing user only on a matching verified
        email. Linking from here attaches it to the account they already have, so one human keeps
        one auth.uid() — which is what every RLS policy in the schema is keyed on.
      */}
      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Google sign-in</h2>
        {googleLinked ? (
          <p data-google-linked>
            Your Google account is linked. <em>Continue with Google</em> signs you in as you, even
            if its address is not the one you joined with.
          </p>
        ) : (
          <p>
            <a href="/auth/link/google" data-google-link>
              Link a Google account
            </a>{" "}
            — then you can sign in with Google, at any address. Without this, signing in with a
            Google account at a different address is not recognised as you.
          </p>
        )}
      </section>

      {error && <p role="alert">{explainLinkReason(error) ?? explainProfileRefusal(error)}</p>}
      {saved && !error && <p role="status">Saved.</p>}
      {linked && !error && <p role="status">Google account linked.</p>}
    </main>
  );
}
