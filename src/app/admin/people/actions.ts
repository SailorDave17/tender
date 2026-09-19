"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UUID } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";

const PEOPLE = "/admin/people";

/**
 * Suspend and lift (story #36 AC 4). Both are ordinary writes through the admin's own
 * cookie-bound client, so 0023's policies decide who may: `suspension_insert_admin` refuses a
 * non-admin (and an admin attributing the suspension to anyone but themselves) with 42501, and
 * `suspension_delete_admin` lets a non-admin's delete match nothing.
 */

function personId(formData: FormData): string {
  const id = formData.get("person_id");
  if (typeof id !== "string" || !UUID.test(id)) redirect(`${PEOPLE}?error=refused`);
  return id;
}

export async function suspendPerson(formData: FormData): Promise<void> {
  const id = personId(formData);
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const { error } = await client.from("suspension").insert({ person_id: id, suspended_by: user.id });
  // 23505 is a second tap on a person already suspended: the state asked for already holds.
  if (error && error.code !== "23505") redirect(`${PEOPLE}?error=refused`);

  revalidatePath(PEOPLE);
  redirect(`${PEOPLE}?done=suspended`);
}

export async function liftSuspension(formData: FormData): Promise<void> {
  const id = personId(formData);
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  // The count is read because an RLS-refused delete is not an error — it matches zero rows and
  // reports success. Zero here is either "already lifted" or "not the admin", and neither is a
  // lift this action performed, so it does not say it did.
  const { error, count } = await client.from("suspension").delete({ count: "exact" }).eq("person_id", id);
  if (error || !count) redirect(`${PEOPLE}?error=refused`);

  revalidatePath(PEOPLE);
  redirect(`${PEOPLE}?done=lifted`);
}
