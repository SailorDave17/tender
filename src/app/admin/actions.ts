"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The admin's one write on the club: replace the invite code (story #16). Nothing is decided
 * here — rotate_invite_code() (0003) is a definer function that decides who may call it from
 * person.is_admin, draws the new code, writes it and returns it, and raises 42501 otherwise.
 * A direct POST to this action with a crew's session gets that refusal from Postgres, whatever
 * the page showed. The code itself is never carried in a form field or a URL: the page reads it
 * back through current_invite_code() on the next render.
 *
 * The confirmation is the page's (a second form behind ?confirm=rotate), not this action's —
 * a Server Action cannot ask; it can only refuse a request that did not come through the
 * confirm form, which is what the `confirmed` field is for.
 */

const ADMIN = "/admin";

export async function rotateInviteCode(formData: FormData): Promise<void> {
  if (formData.get("confirmed") !== "yes") redirect(`${ADMIN}?confirm=rotate`);

  const client = await supabaseServer();
  const { error } = await client.rpc("rotate_invite_code");
  if (error) redirect(`${ADMIN}?error=refused`);

  revalidatePath(ADMIN);
  redirect(`${ADMIN}?rotated=1`);
}
