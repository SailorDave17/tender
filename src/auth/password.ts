/**
 * Password sign-in for a returning member (#82). The decision, as a pure function over injected
 * effects, so every branch — a wrong password, a session with no membership behind it — is a unit
 * test with no cookies and no Supabase.
 *
 * The one thing this path does NOT share with the magic link and the Google redirect is
 * `/auth/callback`: `signInWithPassword` returns a session directly. So the terminal guard that
 * lives at the callback — no person row, no way in — has to be applied HERE too, or the callback
 * bypass would be a route in for a confirmed stray (signups are ON, so anyone can mint a
 * password account against any address). This module refuses a session whose user has no person
 * row and signs it back out (#82 AC 7). It does not CREATE the row — only the callback does, off
 * the attestation an email-gated user carries or the Google gate pass — so a member who set a
 * password at sign-up still has to open the emailed link once before password sign-in works,
 * which is exactly the order AC 1 states.
 */

export const PASSWORD_MIN = 8;

/** The one message a success on the Forgot screen returns — shared with the magic-link arm. */
export const WRONG_CREDENTIALS = "That email and password do not match. Check them and try again.";

/**
 * Shown to a session that authenticated but has no membership behind it: a confirmed stray, or a
 * member who set a password at sign-up and has not yet opened the emailed link. Names the way
 * forward for the second, larger group without revealing which of the two they are.
 */
export const NOT_A_MEMBER =
  "That account is not linked to a member here. If you just signed up, open the link we emailed you to finish. Otherwise ask the club for an invite.";

export type PasswordCheck = { ok: true } | { ok: false; message: string };

/** The app's password policy, in one place: sign-up (#82 AC 1) and the reset landing (AC 5) share it. */
export function validatePassword(password: string): PasswordCheck {
  if (password.length < PASSWORD_MIN) {
    return { ok: false, message: `Choose a password of at least ${PASSWORD_MIN} characters.` };
  }
  return { ok: true };
}

export type ResetReason = "mismatch" | "weak" | "failed" | "expired";

/**
 * The set-new-password form's check (#82 AC 5): the two boxes must match and the result must meet
 * the policy. Pure, so the reset landing's decision is a unit test with no session. Returns a
 * reason key the page renders with `explainResetError` — the same decision/explain split the
 * callback and landing pages use. Mismatch is reported before length, because "they don't match"
 * is the more useful thing to say when both are wrong: a mistyped box is not a chosen password.
 */
export function checkNewPassword(
  password: string,
  confirm: string,
): { ok: true } | { ok: false; reason: "mismatch" | "weak" } {
  if (password !== confirm) return { ok: false, reason: "mismatch" };
  if (!validatePassword(password).ok) return { ok: false, reason: "weak" };
  return { ok: true };
}

/** The sentence the reset-password page shows for each failure key — one place, page and test agree. */
export function explainResetError(reason: string): string {
  switch (reason) {
    case "mismatch":
      return "Those two passwords do not match.";
    case "weak":
      return `Choose a password of at least ${PASSWORD_MIN} characters.`;
    case "failed":
      return "That could not be saved. The link may have expired — start again from Forgot your password.";
    default:
      return "Something went wrong. Start again from Forgot your password.";
  }
}

export type PasswordSignInInput = { email: string; password: string };

export type PasswordSignInDeps = {
  /** Exchanges email + password for a session; the error carries GoTrue's code/message. */
  authenticate: (
    email: string,
    password: string,
  ) => Promise<{ userId?: string; error?: { code?: string; message: string } }>;
  /** Is there a person row for this auth user? Read scoped to their own id. */
  hasPerson: (userId: string) => Promise<boolean>;
  /** Undo the session `authenticate` just wrote, when we refuse the sign-in after it. */
  signOut: () => Promise<void>;
};

export type PasswordSignInResult = {
  status: 200 | 400 | 401 | 403;
  body: { message?: string; redirect?: string };
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function passwordSignIn(
  input: PasswordSignInInput,
  deps: PasswordSignInDeps,
): Promise<PasswordSignInResult> {
  const email = input.email.trim().toLowerCase();
  // No password-policy check on sign-in: a short password is simply a wrong one, and rejecting it
  // here would both leak the policy and lock out anyone signing in after the policy tightened.
  if (!EMAIL.test(email) || input.password.length === 0) {
    return { status: 400, body: { message: "Enter your email and your password." } };
  }

  const result = await deps.authenticate(email, input.password);
  // Every auth failure — wrong password, unknown address, unconfirmed account — answers the SAME
  // sentence and status, so the response reveals nothing about which addresses have accounts.
  if (result.error || !result.userId) {
    return { status: 401, body: { message: WRONG_CREDENTIALS } };
  }

  // The session is real, but a session is not a membership. Only the callback ever mints a person
  // row; a user that reaches here without one is a stray this bypass must not admit (AC 7).
  if (!(await deps.hasPerson(result.userId))) {
    await deps.signOut();
    return { status: 403, body: { message: NOT_A_MEMBER } };
  }

  return { status: 200, body: { redirect: "/board" } };
}
