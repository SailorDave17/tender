import Link from "next/link";
import { ForgotForm } from "./ForgotForm";

export const dynamic = "force-dynamic";

/**
 * Forgot my password (#82) — reached from the Sign in screen. Since #99 it has exactly one option:
 * reset the password. The other was *Email me a sign-in link*, and the magic link is gone.
 *
 * It is still the route in for every password-less account — every member from before #82, and
 * every Google-created one — because resetting sets a first password rather than replacing one.
 * It is also the way out for the one population #99 can strand: a member who signed up before it
 * and never opened their emailed link has an auth user and no person row, and the reset link goes
 * through /auth/callback, where `ensurePerson` mints the row.
 */
export default function ForgotPage() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "28rem" }}>
      <h1>Forgot your password?</h1>
      <p>
        Enter your email and we will send you a link to set a new password. If you have never had
        one — you joined before passwords, or you use Google — this is how you set your first.
      </p>
      <ForgotForm />
      <p style={{ marginTop: "1rem" }}>
        <Link href="/join">Back to sign in</Link>
      </p>
    </main>
  );
}
