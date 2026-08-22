"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseRaceDateForm } from "@/dates/race-date";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The two admin writes on race dates. Both run through the cookie-bound client, so the database
 * decides authorization: 0004's policies admit an admin's row and refuse anyone else's, whatever
 * this code believes about the caller — a direct POST to a Server Action with a crew's session
 * gets 42501 from Postgres, not a row. That is the authorization check the Next docs ask every
 * Server Function to carry; it lives in the migration rather than here so it cannot drift.
 *
 * Refusals come back to the page as ?error=<reason> (the same shape /join uses), which keeps the
 * form a plain HTML form — no client JavaScript on an admin screen used a dozen times a season.
 */

const ADMIN_DATES = "/admin/dates";

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function createRaceDate(formData: FormData): Promise<void> {
  const parsed = parseRaceDateForm(
    { date: field(formData, "date"), time: field(formData, "time"), title: field(formData, "title") },
    new Date(),
  );
  if (!parsed.ok) redirect(`${ADMIN_DATES}?error=${parsed.reason}`);

  const client = await supabaseServer();
  const { error } = await client
    .from("race_date")
    .insert({ starts_at: parsed.startsAt.toISOString(), title: parsed.title });
  if (error) redirect(`${ADMIN_DATES}?error=refused`);

  revalidatePath(ADMIN_DATES);
  revalidatePath("/board");
  redirect(ADMIN_DATES);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setPublished(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  const published = field(formData, "published") === "true";
  if (!UUID.test(id)) redirect(`${ADMIN_DATES}?error=refused`);

  const client = await supabaseServer();
  const { error, count } = await client
    .from("race_date")
    .update({ published }, { count: "exact" })
    .eq("id", id);
  // A non-admin's update matches zero rows rather than erroring (0004's using clause hides
  // every row from it), so "nothing changed" is a refusal too, not a success.
  if (error || !count) redirect(`${ADMIN_DATES}?error=refused`);

  revalidatePath(ADMIN_DATES);
  revalidatePath("/board");
  redirect(ADMIN_DATES);
}
