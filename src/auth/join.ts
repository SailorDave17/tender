import { timingSafeEqual } from "node:crypto";
import type { PassPayload } from "./pass";

/**
 * The invite gate, as a pure decision over injected effects.
 *
 * The route handler supplies the side effects; everything that decides whether they run lives
 * here so a unit test with fakes can assert the negative cases — a wrong code or a missing
 * attestation must reach NEITHER the user store NOR the mailer (story #15 AC 3), and on the
 * Google path must set no pass and start no redirect (story #70 AC 4).
 *
 * Order matters: the attestation is checked before the code is even read, the code before any
 * user is touched, and the user is created (or found) before the link is sent. Since #70 the
 * platform no longer refuses a link to an unknown address on its own — *Allow new users to sign
 * up* is ON so that Google sign-up can work (epic #7 decision E, dashboard half reversed
 * 2026-08-23) — so creating the user first is what puts the attestation in its metadata, and
 * `shouldCreateUser: false` on the send is what keeps this route from minting an unattested one.
 * An auth user that arrives at /auth/callback with no attestation and no gate pass is deleted
 * there (src/auth/person.ts).
 */

export type JoinInput = {
  email: string;
  displayName: string;
  code: string;
  attested: boolean;
};

export type JoinDeps = {
  /** The club's current invite code, read with the service role — never by a client. */
  inviteCode: () => Promise<string>;
  /** Creates the auth user, or reports that one already exists for the address. */
  createUser: (user: {
    email: string;
    user_metadata: { display_name: string; adult_attested_at: string };
  }) => Promise<{ created: boolean } | { error: string }>;
  /** Sends the magic link to an address that already has a user (shouldCreateUser: false). */
  sendMagicLink: (email: string) => Promise<{ error?: string }>;
  now?: () => Date;
};

export type JoinResult = { status: 200 | 400 | 403 | 500; body: { message: string } };

/** The one message a success returns, whether or not the address was known — it must not leak. */
export const GENERIC_OK = "If that address can sign in, a link is on its way. Check your inbox.";

export function codesMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied.normalize("NFKC").trim());
  const b = Buffer.from(expected.normalize("NFKC").trim());
  // timingSafeEqual throws on unequal lengths; compare lengths first and let that be the answer,
  // which leaks only the length, never the bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function join(input: JoinInput, deps: JoinDeps): Promise<JoinResult> {
  if (!input.attested) {
    return { status: 400, body: { message: "You must confirm that you are 18 or over." } };
  }
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL.test(email) || displayName.length < 1 || displayName.length > 80) {
    return { status: 400, body: { message: "Enter a name and a valid email address." } };
  }
  if (!codesMatch(input.code, await deps.inviteCode())) {
    return { status: 403, body: { message: "That invite code is not this season's." } };
  }

  const created = await deps.createUser({
    email,
    user_metadata: { display_name: displayName, adult_attested_at: (deps.now ?? (() => new Date()))().toISOString() },
  });
  if ("error" in created) {
    return { status: 500, body: { message: "Could not start sign-in. Try again in a minute." } };
  }

  const sent = await deps.sendMagicLink(email);
  if (sent.error) {
    return { status: 500, body: { message: "Could not send the link. Try again in a minute." } };
  }
  return { status: 200, body: { message: GENERIC_OK } };
}

// ---------------------------------------------------------------------------------------------
// Sign up finishing with Google (#70 AC 4): the same gate, a different exit.

export type GoogleSignupInput = {
  displayName: string;
  code: string;
  attested: boolean;
};

export type GoogleSignupDeps = {
  inviteCode: () => Promise<string>;
  /** Sets the signed gate-pass cookie on the response. */
  setPass: (payload: PassPayload) => Promise<void>;
  /** Starts the OAuth redirect; resolves to the URL the browser must go to. */
  startOAuth: () => Promise<{ url: string } | { error: string }>;
  now?: () => Date;
};

export type GoogleSignupResult =
  | { status: 200; body: { url: string } }
  | { status: 400 | 403 | 500; body: { message: string } };

export async function googleSignup(
  input: GoogleSignupInput,
  deps: GoogleSignupDeps,
): Promise<GoogleSignupResult> {
  if (!input.attested) {
    return { status: 400, body: { message: "You must confirm that you are 18 or over." } };
  }
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    return { status: 400, body: { message: "Enter your name." } };
  }
  if (!codesMatch(input.code, await deps.inviteCode())) {
    return { status: 403, body: { message: "That invite code is not this season's." } };
  }

  const issued = (deps.now ?? (() => new Date()))().toISOString();
  await deps.setPass({ display_name: displayName, adult_attested_at: issued, issued_at: issued });

  const started = await deps.startOAuth();
  if ("error" in started) {
    return { status: 500, body: { message: "Could not start Google sign-in. Try again in a minute." } };
  }
  return { status: 200, body: { url: started.url } };
}
