/**
 * The Forgot-my-password screen's one arm (#82 AC 4, narrowed by #99): send a password-reset
 * email.
 *
 * Until #99 this file also held `signIn` — an email-only magic link for a returning member. That
 * mechanism is gone everywhere: a sign-up now finishes in a session (src/auth/join.ts) and a
 * returning member signs in with a password (src/auth/password.ts), so the only mail this app
 * sends about identity is a reset. `signIn`, `isNotAUser` and `SignInDeps` were deleted with their
 * tests rather than left unreferenced, and `GENERIC_OK` moved here from join.ts with it: it is the
 * one message a success on this screen returns, and it is now worded for a reset, because "a link
 * is on its way" was false on every other path that used to say it.
 *
 * `resetPasswordForEmail` does not reveal whether the address is registered — it answers success
 * either way and simply sends nothing for an unknown one — so "does not reveal whether an address
 * is registered" is a property of the platform call, not something this code has to defend. An
 * error therefore means a real transport failure rather than an unknown address, and gets its own
 * status without leaking anything: registration looks identical from the outside.
 */

/** The one message a success on the Forgot screen returns — it must not reveal the address. */
export const GENERIC_OK =
  "If that address has an account here, a password reset link is on its way. Check your inbox.";

export type SignInResult = { status: 200 | 400 | 500; body: { message: string } };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RequestResetDeps = {
  sendReset: (email: string) => Promise<{ error?: { message: string } }>;
};

export async function requestReset(input: { email: string }, deps: RequestResetDeps): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return { status: 400, body: { message: "Enter a valid email address." } };
  }
  const sent = await deps.sendReset(email);
  if (sent.error) {
    return { status: 500, body: { message: "Could not send the reset email. Try again in a minute." } };
  }
  return { status: 200, body: { message: GENERIC_OK } };
}
