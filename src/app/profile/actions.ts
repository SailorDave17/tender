"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseProfileForm, type Skill } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Save the signed-in person's profile. Two writes through the cookie-bound client, so the
 * database decides whose rows change: 0002's person_update_self and 0005's
 * person_contact_update_self admit the caller's own row and no other, and the column grants
 * admit rating / skills / any_hull / hulls and phone and nothing else — a crafted POST naming
 * another id matches zero rows, and one naming is_admin is refused at the grant.
 *
 * The two writes are not one transaction. Phone is saved second and on its own failure the
 * profile still holds the rating, which is the useful half; the page shows the refusal.
 */

const PROFILE = "/profile";

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function saveProfile(formData: FormData): Promise<void> {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  // Both lists are re-read here rather than trusted from the form: the page's copy is whatever
  // that render held, and the codes arrive from the client. An unknown code is refused against
  // this read, which is the only check the database does not make (skills is text[], no array FK).
  const [{ data: classes }, { data: skillRows }] = await Promise.all([
    client.from("boat_class").select("name").order("name"),
    client.from("skill").select("code, label, level, sort").order("sort"),
  ]);
  const parsed = parseProfileForm(
    {
      skills: formData.getAll("skills").filter((s): s is string => typeof s === "string"),
      hulls: field(formData, "hulls"),
      classes: formData.getAll("classes").filter((c): c is string => typeof c === "string"),
      phone: field(formData, "phone"),
    },
    (classes ?? []).map((c) => c.name),
    (skillRows ?? []) as Skill[],
  );
  if (!parsed.ok) redirect(`${PROFILE}?error=${parsed.reason}`);

  // `rating` is written from the ticked set, never from the form — it is the derived ordinal the
  // engine compares, and the client has no say in it beyond which skills it sent.
  const person = await client
    .from("person")
    .update(
      { rating: parsed.rating, skills: parsed.skills, any_hull: parsed.anyHull, hulls: parsed.hulls },
      { count: "exact" },
    )
    .eq("id", user.id);
  // Zero rows is a refusal (the policy hid the row), not a success.
  if (person.error || !person.count) redirect(`${PROFILE}?error=refused`);

  const contact = await client
    .from("person_contact")
    .update({ phone: parsed.phone }, { count: "exact" })
    .eq("person_id", user.id);
  if (contact.error || !contact.count) redirect(`${PROFILE}?error=refused`);

  revalidatePath(PROFILE);
  revalidatePath("/board");
  redirect(`${PROFILE}?saved=1`);
}
