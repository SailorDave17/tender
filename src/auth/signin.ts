import { GENERIC_OK } from "./join";

/**
 * Sign in for a returning member (#70 AC 2): an email address and nothing else. No invite code
 * is read and no user is created — the one effect is the magic link, sent with
 * `shouldCreateUser: false`, so an address with no auth user gets nothing. Supabase reports that
 * case as a refusal; it is swallowed here, because the response must not say whether the address
 * is known (the same sentence and status as the known case).
 */

export type SignInDeps = {
  /** Sends the magic link with shouldCreateUser: false; the error carries Supabase's code/message. */
  sendMagicLink: (email: string) => Promise<{ error?: { code?: string; message: string } }>;
};

export type SignInResult = { status: 200 | 400 | 500; body: { message: string } };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Is this error Supabase saying "no such user, and I will not create one"? GoTrue answers a
 * `shouldCreateUser: false` send for an unknown address with `otp_disabled` / "Signups not
 * allowed for otp"; both spellings are matched because the code arrived in the client after the
 * message did.
 */
export function isNotAUser(error: { code?: string; message: string }): boolean {
  if (error.code === "otp_disabled") return true;
  return /signups? not allowed/i.test(error.message);
}

export async function signIn(input: { email: string }, deps: SignInDeps): Promise<SignInResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) {
    return { status: 400, body: { message: "Enter a valid email address." } };
  }
  const sent = await deps.sendMagicLink(email);
  if (sent.error && !isNotAUser(sent.error)) {
    return { status: 500, body: { message: "Could not send the link. Try again in a minute." } };
  }
  return { status: 200, body: { message: GENERIC_OK } };
}
