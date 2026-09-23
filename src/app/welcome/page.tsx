import { redirect } from "next/navigation";
import { SIGN_IN_URL, SIGNED_IN_HOME } from "@/auth/gate";
import { PhoneField, SkillsFieldset } from "@/profile/fields";
import { explainProfileRefusal, type Skill } from "@/profile/profile";
import { NAME_MAX, explainWelcomeRefusal } from "@/profile/welcome";
import { supabaseServer } from "@/lib/supabase/server";
import { finishProfile } from "./actions";

export const dynamic = "force-dynamic";

/**
 * /welcome — "Finish your profile" (story #219). Where a signed-in member whose
 * `profile_completed_at` is null is sent from every gated path (src/auth/gate.ts), and the one
 * page the proxy lets them stay on.
 *
 * The name is required and pre-filled with whatever the account already holds, such as a Google
 * given name or the provisional one the invite gate writes since #220. Phone and experience are
 * /profile's own fields (src/profile/fields.tsx) and optional: "Skip for now" keeps the name and
 * nothing else, and the board's "set your competence" banner follows a member who skipped.
 *
 * The page re-checks what the proxy decided, because a proxy read can fail open (standingFromRow):
 * a finished member is sent to the board, and a session with no person row gets the same
 * `not-invited` explanation /profile gives it.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);

  const [{ data: me }, { data: contact }, { data: skillRows }] = await Promise.all([
    client
      .from("person")
      .select("display_name, skills, profile_completed_at")
      .eq("id", user.id)
      .maybeSingle(),
    client.from("person_contact").select("phone").eq("person_id", user.id).maybeSingle(),
    client.from("skill").select("code, label, level, sort").order("sort"),
  ]);
  if (!me) redirect("/join?error=not-invited");
  if (me.profile_completed_at) redirect(SIGNED_IN_HOME);

  const skills = (skillRows ?? []) as Skill[];
  const { error } = await searchParams;

  return (
    <main data-page="welcome">
      <h1>Finish your profile</h1>
      <p>Your account is ready. Tell the club who you are, and you are in.</p>

      <form action={finishProfile} data-stack="loose" data-gap-top>
        <label>
          Your name
          <input
            name="displayName"
            required
            maxLength={NAME_MAX}
            autoComplete="name"
            defaultValue={me.display_name ?? ""}
          />
        </label>
        <p data-hint>Skippers and crew see this on the board.</p>

        <fieldset data-optional>
          <legend>Optional — you can skip these for now</legend>
          <SkillsFieldset skills={skills} checked={me.skills ?? []} legend="How competent are you?" />
          <PhoneField defaultValue={contact?.phone ?? ""} />
        </fieldset>

        <button type="submit" data-finish>
          Save and go to the board
        </button>
        <button type="submit" name="skip" value="1" data-skip>
          Skip for now
        </button>
        <p data-hint>
          Skip saves your name only. You can add your experience and phone later from your profile —
          you will need your experience before you can mark the days you can sail.
        </p>
      </form>

      {error && (
        <p role="alert">{explainWelcomeRefusal(error) ?? explainProfileRefusal(error)}</p>
      )}
    </main>
  );
}
