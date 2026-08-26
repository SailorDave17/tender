"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseBoatForm } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Add a boat. Through the cookie-bound client, so 0006's boat_insert_own policy is what
 * decides the owner: the row's owner_id is the caller's id and a crafted POST naming
 * someone else's is refused by Postgres, whatever this code is told.
 */

const BOATS = "/boats";

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function createBoat(formData: FormData): Promise<void> {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const { data: classes } = await client.from("boat_class").select("name").order("name");
  const parsed = parseBoatForm(
    { name: field(formData, "name"), class: field(formData, "class"), minimum: field(formData, "minimum") },
    (classes ?? []).map((c) => c.name),
  );
  if (!parsed.ok) redirect(`${BOATS}?error=${parsed.reason}`);

  const { error } = await client.from("boat").insert({
    owner_id: user.id,
    name: parsed.name,
    class: parsed.boatClass,
    default_minimum: parsed.minimum,
  });
  if (error) redirect(`${BOATS}?error=refused`);

  revalidatePath(BOATS);
  redirect(BOATS);
}
