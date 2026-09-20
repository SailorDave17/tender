"use server";

import { redirect } from "next/navigation";
import { confirmed, deleteAccount } from "@/profile/delete-account";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Delete the signed-in person's own account (story #42 AC 2).
 *
 * Two clients, on purpose. `delete_person()` (0027) is called through the COOKIE-BOUND client,
 * so it runs as the person and the database decides who may delete whom — the same shape as
 * every other write in this app. The service role appears only for the auth user afterwards,
 * because that is GoTrue's table and no client role may touch it; it is never used to reach the
 * person's rows, which would make this action the sole author of its own authorization
 * (src/admin/load.ts gives the same reason for the admin screens). The order is
 * `src/profile/delete-account.ts`'s, and is tested there.
 *
 * The confirm is a required checkbox whose value the action checks again: a `required` control
 * is the browser's, and a direct POST carries whatever it likes (Next 16's own guidance that
 * render-time gating is not a boundary). A post without it is refused with a sentence.
 *
 * On success the local session is cleared and the person lands on /join with a note. `scope:
 * "local"` because the auth user no longer exists: a global sign-out would ask GoTrue to revoke
 * the tokens of a user it cannot find and report an error about a session that is already
 * dead. On a failure at the AUTH step the rows are gone and the sign-in record is not — the
 * person is signed out all the same (there is no profile to return to) and /join says what
 * happened, so the club admin can remove the auth user from the dashboard.
 */
export async function deleteMyAccount(formData: FormData): Promise<void> {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  if (!confirmed(formData.get("confirm"))) redirect("/profile?error=delete-unconfirmed");

  const result = await deleteAccount({
    deletePerson: async () => {
      const { data, error } = await client.rpc("delete_person", { person_id: user.id });
      if (error) return { error: error.message };
      return { kept: typeof data === "number" ? data : 0 };
    },
    deleteAuthUser: async () => {
      const { error } = await supabaseAdmin().auth.admin.deleteUser(user.id);
      return error ? { error: error.message } : {};
    },
  });

  if (!result.ok && result.step === "person") {
    console.error(`delete account: delete_person refused: ${result.reason}`);
    redirect("/profile?error=delete-person");
  }
  if (!result.ok) {
    // The rows are gone; the sign-in record is not. Say so where the person lands.
    console.error(`delete account: auth user ${user.id} not deleted after the person rows were: ${result.reason}`);
  }
  await client.auth.signOut({ scope: "local" });
  redirect(result.ok ? "/join?deleted=1" : "/join?deleted=partial");
}
