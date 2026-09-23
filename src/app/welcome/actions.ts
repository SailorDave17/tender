"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { SIGN_IN_URL, SIGNED_IN_HOME, WELCOME_PATH } from "@/auth/gate";
import { parseWelcomeForm } from "@/profile/welcome";
import type { Skill } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Finish the signed-in member's profile (#219): their name, whatever optional fields they filled,
 * and `profile_completed_at` — then the board.
 *
 * Everything is validated BEFORE anything is written, so a refused name writes nothing (AC 3).
 * The writes go through the cookie-bound client, so the database decides whose rows change:
 * `person_update_self` (0002) admits the caller's own row and no other, and the column grants
 * admit the name, the rating and skills, and — since 0031 — `profile_completed_at`, and nothing
 * else. The contact row is written first and the person row last, so `profile_completed_at` is
 * set only once everything before it has landed: a refusal part-way leaves the member unfinished
 * and on /welcome, never finished with their phone silently dropped.
 */

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function finishProfile(formData: FormData): Promise<void> {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);

  // Re-read rather than trusted from the form, for /profile's reason: the codes arrive from the
  // client, and an unknown one is refused against this read.
  const { data: skillRows } = await client.from("skill").select("code, label, level, sort").order("sort");
  const parsed = parseWelcomeForm(
    {
      displayName: field(formData, "displayName"),
      skills: formData.getAll("skills").filter((s): s is string => typeof s === "string"),
      phone: field(formData, "phone"),
      skip: formData.get("skip") !== null,
    },
    (skillRows ?? []) as Skill[],
  );
  if (!parsed.ok) redirect(`${WELCOME_PATH}?error=${parsed.reason}`);

  if (parsed.phone !== undefined) {
    const contact = await client
      .from("person_contact")
      .update({ phone: parsed.phone }, { count: "exact" })
      .eq("person_id", user.id);
    if (contact.error || !contact.count) redirect(`${WELCOME_PATH}?error=refused`);
  }

  const person = await client
    .from("person")
    .update(
      {
        display_name: parsed.displayName,
        ...(parsed.competence ? { rating: parsed.competence.rating, skills: parsed.competence.skills } : {}),
        profile_completed_at: new Date().toISOString(),
      },
      { count: "exact" },
    )
    .eq("id", user.id);
  // Zero rows is a refusal (the policy hid the row), not a success.
  if (person.error || !person.count) redirect(`${WELCOME_PATH}?error=refused`);

  revalidatePath(SIGNED_IN_HOME);
  redirect(SIGNED_IN_HOME);
}
