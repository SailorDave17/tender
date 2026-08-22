import { timingSafeEqual } from "node:crypto";

/**
 * The invite gate, as a pure decision over injected effects.
 *
 * The route handler supplies the three side effects; everything that decides whether they run
 * lives here so a unit test with fakes can assert the negative cases — a wrong code or a missing
 * attestation must reach NEITHER the user store NOR the mailer (story #15 AC 3).
 *
 * Order matters: the attestation is checked before the code is even read, the code before any
 * user is touched, and the user is created (or found) before the link is sent — a link to an
 * address with no user would be refused by Supabase with signups OFF, which is the setting epic
 * decision E relies on.
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
