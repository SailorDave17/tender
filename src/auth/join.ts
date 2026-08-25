import { timingSafeEqual } from "node:crypto";
import type { FoundUser } from "./find-user";
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
 *
 * Which is why, since #85, `createUser` reporting that the address is taken is not the end of the
 * story. Signups being ON, the public anon key can mint an attestation-less auth user against any
 * address from any browser; #22's AC 4 does it deliberately. The old code read `email_exists` as
 * *the returning-member case* and moved on, so the metadata this gate had just assembled — the
 * name they typed, the box they ticked — was thrown away and the link went out anyway. The
 * callback then found no attestation, deleted the user and told a legitimately invited member
 * they were not a member. It self-heals: the delete clears the address, so the second attempt
 * works. A defect that disappears when you look at it is the worst kind to leave.
 *
 * So the gate now looks at who is actually there, and stamps its attestation onto an existing
 * user that has none. The invite code is what authorises that: by this point the same submission
 * has proved the code and ticked 18+, which is exactly the authority a fresh `createUser` acts on.
 * Doing it here rather than at the callback keeps `ensurePerson` the single terminal guard — the
 * callback holds no invite code and no ticked box, so nothing there could authorise it.
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
  /** The auth user already at this address, and whether it carries an attestation (#85). */
  existingUser: (email: string) => Promise<FoundUser>;
  /** Writes this gate's attestation and name onto an existing auth user, as the service role (#85). */
  attestExisting: (
    id: string,
    meta: { display_name: string; adult_attested_at: string },
  ) => Promise<{ error?: string }>;
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

  const meta = {
    display_name: displayName,
    adult_attested_at: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const created = await deps.createUser({ email, user_metadata: meta });
  if ("error" in created) {
    return { status: 500, body: { message: "Could not start sign-in. Try again in a minute." } };
  }

  if (!created.created) {
    // The address is taken. Either a member is using the Sign up tab by mistake, or a stray auth
    // user is sitting on their address (#85). The attestation tells them apart, and it is the
    // same predicate the callback will apply in a moment — see attestationOf.
    const existing = await deps.existingUser(email);
    if ("error" in existing || !existing.found) {
      // Not found here contradicts the createUser that just refused, so something raced or the
      // lookup is broken. Refuse rather than send a link this gate cannot stand behind: sending
      // is what turned the original defect into a refusal in the member's face.
      return { status: 500, body: { message: "Could not start sign-in. Try again in a minute." } };
    }
    if (!existing.attested) {
      const written = await deps.attestExisting(existing.id, meta);
      if (written.error) {
        return { status: 500, body: { message: "Could not start sign-in. Try again in a minute." } };
      }
    }
    // An attested user is left exactly as they are. Nothing here may overwrite what a member
    // already has — and `person.display_name` is beyond this path's reach in any case, because
    // ensurePerson returns on its first line when a person row exists.
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
