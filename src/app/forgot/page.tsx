import Link from "next/link";
import { ForgotForm } from "./ForgotForm";

export const dynamic = "force-dynamic";

/**
 * Forgot my password (#82) — reached from the Sign in screen. A separate screen with exactly two
 * options (owner decision, 2026-08-24): email a sign-in link, or reset the password. It is also
 * the route in for every password-less account — every member from before #82, and every
 * Google-created one: the sign-in-link arm works as it always has, and the reset arm sets a first
 * password.
 */
export default function ForgotPage() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "28rem" }}>
      <h1>Forgot your password?</h1>
      <p>
        Enter your email and choose one. If you never set a password — you joined before passwords,
        or you use Google — the sign-in link still works, and resetting sets your first password.
      </p>
      <ForgotForm />
      <p style={{ marginTop: "1rem" }}>
        <Link href="/join">Back to sign in</Link>
      </p>
    </main>
  );
}
