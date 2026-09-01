import { timingSafeEqual } from "node:crypto";
import type { FoundUser } from "./find-user";
import type { PassPayload } from "./pass";
import { validatePassword } from "./password";
import { ensurePerson, type PersonStore } from "./person";

/**
 * The invite gate, as a pure decision over injected effects.
 *
 * The route handler supplies the side effects; everything that decides whether they run lives
 * here so a unit test with fakes can assert the negative cases — a wrong code or a missing
 * attestation must reach neither the user store nor the person store (story #15 AC 3), and on the
 * Google path must set no pass and start no redirect (story #70 AC 4).
 *
 * Since #99 this path **sends no email at all**. The invite code, the ticked box and a chosen
 * password are the whole of a sign-up: everything the emailed link went on to establish was
 * already established one screen earlier, and its only remaining job was to carry a PKCE code to
 * /auth/callback, which is where the person row was minted. So the gate mints it here instead —
 * by calling `ensurePerson`, which stays the only writer of `person` — and signs the member in
 * with the password they just chose. Address verification is not lost, because it was never
 * gained: `createUser` runs with `email_confirm: true`, so the link proved possession of nothing.
 *
 * Order matters: the attestation is checked before the code is even read, the code before any
 * user is touched, and the person row before anybody is signed in. Since #70 the platform no
 * longer refuses to create a user on its own — *Allow new users to sign up* is ON so that Google
 * sign-up can work (epic #7 decision E, dashboard half reversed 2026-08-23) — so creating the
 * user here is what puts the attestation in its metadata, and that attestation is what
 * `ensurePerson` acts on. An auth user that reaches /auth/callback with no attestation and no
 * gate pass is still deleted there (src/auth/person.ts); this path never produces one.
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
 * So the gate looks at who is actually there, and stamps its attestation onto an existing user
 * that has none. The invite code is what authorises that: by this point the same submission has
 * proved the code and ticked 18+, which is exactly the authority a fresh `createUser` acts on.
 * An already-attested user is a different answer since #99 — see ALREADY_A_MEMBER.
 */

export type JoinInput = {
  email: string;
  displayName: string;
  code: string;
  attested: boolean;
  /** Chosen at sign-up (#82): set on the auth user, and used to sign in a line later (#99). */
  password: string;
};

export type JoinDeps = {
  /** The club's current invite code, read with the service role — never by a client. */
  inviteCode: () => Promise<string>;
  /**
   * Creates the auth user with the chosen password, or reports that one already exists (#82).
   * Returns the id on success (#99): the gate needs it to mint the person row without a re-read.
   */
  createUser: (user: {
    email: string;
    password: string;
    user_metadata: { display_name: string; adult_attested_at: string };
  }) => Promise<{ created: true; id: string } | { created: false } | { error: string }>;
  /** The auth user already at this address, and whether it carries an attestation (#85). */
  existingUser: (email: string) => Promise<FoundUser>;
  /**
   * Writes this gate's attestation and name onto an existing UNATTESTED auth user, and sets the
   * password chosen on this submission (#85, extended #82). Only ever called for a stray with no
   * attestation, so setting the password is claiming a squatted address, not overwriting a
   * member's — an already-attested user is refused a line up in `join`.
   */
  attestExisting: (
    id: string,
    meta: { display_name: string; adult_attested_at: string },
    password: string,
  ) => Promise<{ error?: string }>;
  /**
   * The person store `ensurePerson` writes through — the same one /auth/callback supplies. The
   * gate does not insert anything itself: one writer, one predicate (#99 AC 2).
   */
  person: PersonStore;
  /** Signs the member in with the password they just chose; the session lands on the response. */
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  now?: () => Date;
};

export type JoinResult = {
  status: 200 | 400 | 403 | 409 | 500;
  body: { message?: string; redirect?: string; then?: "signin" };
};

/**
 * The sign-up tab's answer for an address that already carries an ATTESTED auth user (#99 AC 4).
 *
 * This reveals that the address is registered, and that is deliberate: the caller has already
 * proved this season's invite code, so they are not a stranger probing addresses. Until #99 the
 * answer was the same generic "a link is on its way" as every other outcome — which was honest
 * only while a link really was on its way to *somebody*. With no link on any path, a generic
 * sentence would simply be a lie told to a member who is now stuck.
 *
 * `then: "signin"` puts them on the Sign in tab, which carries the Forgot link. That is the way
 * out for the one population this can strand: a member who signed up before #99 and never opened
 * their emailed link has an attested auth user, a password and NO person row — so signing in
 * answers NOT_A_MEMBER and signing up answers this. The reset link still goes through
 * /auth/callback, and `ensurePerson` mints their row when it lands.
 */
export const ALREADY_A_MEMBER = "You already have an account here — sign in with your password.";

/** The account exists and the sign-in that should have followed it did not (#99 AC 3). */
export const CREATED_NOT_SIGNED_IN =
  "Your account is set up, but signing you in did not work. Sign in with the email and password you just chose.";

/** Where a finished sign-up lands. A constant, never a caller's value. */
export const AFTER_SIGNUP = "/board";

export function codesMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied.normalize("NFKC").trim());
  const b = Buffer.from(expected.normalize("NFKC").trim());
  // timingSafeEqual throws on unequal lengths; compare lengths first and let that be the answer,
  // which leaks only the length, never the bytes.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CANNOT_START = { status: 500, body: { message: "Could not finish signing up. Try again in a minute." } } as const;

export async function join(input: JoinInput, deps: JoinDeps): Promise<JoinResult> {
  if (!input.attested) {
    return { status: 400, body: { message: "You must confirm that you are 18 or over." } };
  }
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();
  if (!EMAIL.test(email) || displayName.length < 1 || displayName.length > 80) {
    return { status: 400, body: { message: "Enter a name and a valid email address." } };
  }
  // The password is validated before the code is read, alongside the name and email, so a too-short
  // one is refused before anything is touched — same as every other bad-input case (#82).
  const pw = validatePassword(input.password);
  if (!pw.ok) {
    return { status: 400, body: { message: pw.message } };
  }
  if (!codesMatch(input.code, await deps.inviteCode())) {
    return { status: 403, body: { message: "That invite code is not this season's." } };
  }

  const meta = {
    display_name: displayName,
    adult_attested_at: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const created = await deps.createUser({ email, password: input.password, user_metadata: meta });
  if ("error" in created) return CANNOT_START;

  let id: string;
  if (created.created) {
    id = created.id;
  } else {
    // The address is taken. Either a member is using the Sign up tab, or a stray auth user is
    // sitting on their address (#85). The attestation tells them apart, and it is the same
    // predicate ensurePerson applies below — see attestationOf.
    const existing = await deps.existingUser(email);
    if ("error" in existing || !existing.found) {
      // Not found here contradicts the createUser that just refused, so something raced or the
      // lookup is broken. Refuse rather than act on a user this gate cannot identify.
      return CANNOT_START;
    }
    if (existing.attested) {
      // A member's account. Nothing here may overwrite what they already have — not the password,
      // not the metadata, and not `person.display_name`, which ensurePerson leaves alone on its
      // first line in any case. Say so plainly and point at the way in.
      return { status: 409, body: { message: ALREADY_A_MEMBER, then: "signin" } };
    }
    const written = await deps.attestExisting(existing.id, meta, input.password);
    if (written.error) return CANNOT_START;
    id = existing.id;
  }

  // One writer, one predicate. `meta` carries the attestation written a line above, so the
  // delete-a-strayer branch inside ensurePerson is unreachable from here by construction (#99 AC 2).
  const ensured = await ensurePerson({ id, email, user_metadata: meta }, deps.person);
  // Nobody is signed in on a refusal: an account with no membership behind it is exactly what
  // /api/signin refuses a moment later, and a session would only hide that.
  if ("refused" in ensured) return CANNOT_START;

  const signedIn = await deps.signIn(email, input.password);
  if (signedIn.error) {
    // The account and the person row both exist. Telling them the sign-up failed would send them
    // back to a form that will now answer ALREADY_A_MEMBER — so name what happened instead.
    return { status: 500, body: { message: CREATED_NOT_SIGNED_IN, then: "signin" } };
  }
  return { status: 200, body: { redirect: AFTER_SIGNUP } };
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
