"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseProfileForm } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Save the signed-in person's profile. Two writes through the cookie-bound client, so the
 * database decides whose rows change: 0002's person_update_self and 0005's
 * person_contact_update_self admit the caller's own row and no other, and the column grants
 * admit rating / any_hull / hulls and phone and nothing else — a crafted POST naming another id
 * matches zero rows, and one naming is_admin is refused at the grant.
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

  const { data: classes } = await client.from("boat_class").select("name").order("name");
  const parsed = parseProfileForm(
    {
      rating: field(formData, "rating"),
      hulls: field(formData, "hulls"),
      classes: formData.getAll("classes").filter((c): c is string => typeof c === "string"),
      phone: field(formData, "phone"),
    },
    (classes ?? []).map((c) => c.name),
  );
  if (!parsed.ok) redirect(`${PROFILE}?error=${parsed.reason}`);

  const person = await client
    .from("person")
    .update({ rating: parsed.rating, any_hull: parsed.anyHull, hulls: parsed.hulls }, { count: "exact" })
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
