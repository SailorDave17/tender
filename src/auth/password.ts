/**
 * Password sign-in for a returning member (#82). The decision, as a pure function over injected
 * effects, so every branch — a wrong password, a session with no membership behind it — is a unit
 * test with no cookies and no Supabase.
 *
 * The one thing this path does NOT share with the Google redirect and the reset link is
 * `/auth/callback`: `signInWithPassword` returns a session directly. So the terminal guard that
 * lives at the callback — no person row, no way in — has to be applied HERE too, or the callback
 * bypass would be a route in for a confirmed stray (signups are ON, so anyone can mint a
 * password account against any address). This module refuses a session whose user has no person
 * row and signs it back out (#82 AC 7). It does not CREATE the row.
 *
 * #99 changed which population that refusal is about. Until then a member who set a password at
 * sign-up had to open an emailed link once before password sign-in worked, because only the
 * callback minted the row; the invite gate now mints it in the same submission, so a member is
 * never in that state. What is left is a genuine stray — an anon-key account with a password and
 * no invite behind it — plus the shrinking set who signed up before #99 and never opened the link
 * it emailed them. NOT_A_MEMBER is written for both.
 */

export const PASSWORD_MIN = 8;

/** Every failed sign-in answers this, whatever failed, so no address is confirmed or denied. */
export const WRONG_CREDENTIALS = "That email and password do not match. Check them and try again.";

/**
 * Shown to a session that authenticated but has no membership behind it: a confirmed stray, or -
 * since #99, the only other way to be in this state — somebody who signed up BEFORE #99 and never
 * opened the link it emailed them. Names the way forward for the second group without revealing
 * which of the two they are, and that way forward is Forgot my password: the reset link goes
 * through /auth/callback, where `ensurePerson` mints the row their sign-up never finished.
 */
export const NOT_A_MEMBER =
  "That account is not linked to a member here. If you signed up before and never finished, use Forgot my password and the emailed link will complete your account. Otherwise ask the club for this season's invite code.";

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

  // The session is real, but a session is not a membership. `ensurePerson` is the only thing that
  // ever mints a person row, and this route is not one of its callers; a user that reaches here
  // without one is a stray this bypass must not admit (AC 7).
  if (!(await deps.hasPerson(result.userId))) {
    await deps.signOut();
    return { status: 403, body: { message: NOT_A_MEMBER } };
  }

  return { status: 200, body: { redirect: "/board" } };
}
