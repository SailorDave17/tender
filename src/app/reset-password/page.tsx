import { redirect } from "next/navigation";
import { explainResetError } from "@/auth/password";
import { supabaseServer } from "@/lib/supabase/server";
import { setNewPassword } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Where a password-reset email lands (#82 AC 5). The recovery link came through /auth/callback,
 * which exchanged its code for a session, so by here the member is signed in — reading their own
 * user is how we confirm the recovery took. Someone who reaches this page without that session
 * (a direct visit, an expired link that never established one) is sent back to /forgot rather
 * than shown a form that cannot work.
 *
 * The form posts to a Server Action so the rotated session cookies can be written; `updateUser`
 * replaces the credential, after which the old password no longer signs in and the new one does.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/forgot?error=expired");

  const { error } = await searchParams;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "28rem" }}>
      <h1>Set a new password</h1>
      <p>Choose a new password for your account. You are signed in from your reset link.</p>
      <form action={setNewPassword} style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          New password
          <input name="password" type="password" required autoComplete="new-password" minLength={8} />
        </label>
        <label>
          Confirm new password
          <input name="confirm" type="password" required autoComplete="new-password" minLength={8} />
        </label>
        <button type="submit">Save new password</button>
      </form>
      {error && <p role="alert">{explainResetError(error)}</p>}
    </main>
  );
}
