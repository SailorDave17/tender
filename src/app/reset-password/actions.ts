"use server";

import { redirect } from "next/navigation";
import { isCommonPassword } from "@/auth/common-passwords";
import { checkNewPassword } from "@/auth/password";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Set the new password (#82 AC 5). Reached only with a live session — the recovery link came
 * through /auth/callback, which exchanged the code for one. `updateUser({ password })` is a
 * Server Action rather than a route so it can write the rotated session cookies; a Server
 * Component could not.
 *
 * The old password stops working the instant this succeeds and the new one signs in — that is
 * GoTrue replacing the credential, not anything this code does. A member (a person row exists) is
 * never deleted on the recovery leg: `ensurePerson` returns on its first line for them.
 */
export async function setNewPassword(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const client = await supabaseServer();

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/forgot?error=expired");

  const check = checkNewPassword(password, confirm);
  if (!check.ok) redirect(`/reset-password?error=${check.reason}`);
  // #268: the list is server-only, so it is asked here rather than inside `checkNewPassword`, which
  // the Sign up tab also runs in the browser. Same sentence as /api/join's (`COMMON_PASSWORD`).
  if (isCommonPassword(password)) redirect("/reset-password?error=common");

  const { error } = await client.auth.updateUser({ password });
  if (error) redirect("/reset-password?error=failed");

  redirect("/board");
}
