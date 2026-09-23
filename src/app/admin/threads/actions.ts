"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UUID } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { SIGN_IN_URL } from "@/auth/gate";

/**
 * Remove a message as the admin (story #36 AC 2). Bound to the match id by the page; the message
 * id comes from the confirmation form.
 *
 * The admin check is the DATABASE's, not this function's: remove_message() (0023) raises 42501
 * for anyone else, and a Server Action is a POST endpoint anyone can send (Next 16's security
 * guide), so an `if (is_admin)` here would be the check a direct POST skips. The page's 404 and
 * the definer's refusal are the two that matter; this only carries the request to the second.
 */
export async function removeMessage(matchId: string, formData: FormData): Promise<void> {
  if (!UUID.test(matchId)) redirect("/admin/threads");
  const back = `/admin/threads/${matchId}`;
  const messageId = formData.get("message_id");
  if (typeof messageId !== "string" || !UUID.test(messageId)) redirect(`${back}?error=refused`);

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);

  const { error } = await client.rpc("remove_message", { message_id: messageId });
  if (error) redirect(`${back}?error=refused`);

  revalidatePath(back);
  revalidatePath("/admin/threads");
  redirect(`${back}?removed=1`);
}
