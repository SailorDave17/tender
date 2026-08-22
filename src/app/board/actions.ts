"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { availabilityRefusal } from "@/availability/rules";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Mark or unmark the signed-in person for a race day (story #18 AC 4). One Server Action for
 * both directions — a yes is a row, a no is its absence (0005) — decided by the `available`
 * field the form carries.
 *
 * The refusals the board already disables buttons for are applied again here, because a
 * disabled button is a courtesy and not a guard: a person with no rating, or a day already
 * started. The database repeats the first (0005's insert policy) and the ownership rule
 * (person_id = auth.uid()), so a crafted POST for someone else's id is refused by Postgres
 * whatever this code believes.
 */

const BOARD = "/board";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function setAvailability(formData: FormData): Promise<void> {
  const raceDateId = field(formData, "race_date_id");
  const available = field(formData, "available") === "true";
  if (!UUID.test(raceDateId)) redirect(`${BOARD}?error=refused`);

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const [{ data: me }, { data: date }] = await Promise.all([
    client.from("person").select("rating").eq("id", user.id).maybeSingle(),
    client.from("race_date").select("starts_at").eq("id", raceDateId).eq("published", true).maybeSingle(),
  ]);
  if (!me || !date) redirect(`${BOARD}?error=refused`);
  const refusal = availabilityRefusal(me, date, new Date());
  if (refusal) redirect(`${BOARD}?error=${refusal}`);

  if (available) {
    const { error } = await client
      .from("availability")
      .insert({ person_id: user.id, race_date_id: raceDateId });
    // 23505 is the row already being there — the person tapped twice; that is the state they asked for.
    if (error && error.code !== "23505") redirect(`${BOARD}?error=refused`);
  } else {
    const { error } = await client
      .from("availability")
      .delete()
      .eq("person_id", user.id)
      .eq("race_date_id", raceDateId);
    if (error) redirect(`${BOARD}?error=refused`);
  }

  revalidatePath(BOARD);
  redirect(BOARD);
}
