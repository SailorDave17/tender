import { timingSafeEqual } from "node:crypto";
import type { FoundUser } from "./find-user";
import type { ExchangeIdToken } from "./google-signin";
import { NO_CREDENTIAL, NOT_VERIFIED, hasCredential } from "./google-signin";
import { SIGNED_IN_HOME, WELCOME_PATH } from "./gate";
import { validatePassword } from "./password";
import { ensurePerson, type PersonStore } from "./person";

/**
 * The invite gate, as a pure decision over injected effects.
 *
 * The route handler supplies the side effects; everything that decides whether they run lives
 * here so a unit test with fakes can assert the negative cases — a wrong code or a missing
 * attestation must reach neither the user store nor the person store (story #15 AC 3), and on the
 * Google path must exchange no token and mint nothing (story #70 AC 4, re-taken by #173).
 *
 * Since #99 this path **sends no email at all**. The invite code, the 18+ confirmation and a
 * chosen password are the whole of a sign-up: everything the emailed link went on to establish was
 * already established one screen earlier, and its only remaining job was to carry a PKCE code to
 * /auth/callback, which is where the person row was minted. So the gate mints it here instead —
 * by calling `ensurePerson`, which stays the only writer of `person` — and signs the member in
 * with the password they just chose. Address verification is not lost, because it was never
 * gained: `createUser` runs with `email_confirm: true`, so the link proved possession of nothing.
 *
 * Since #220 the form asks for no name either (owner decision 2026-09-22: the sign-up screen is
 * about one thing, the invite code). The 18+ confirmation is a line of text beside the
 * create-account buttons rather than a checkbox, and creating the account is the confirmation —
 * the form still posts `attested: true`, and this gate still refuses a request without it, so a
 * hand-built call that skips the screen gets no account. The row is minted with a provisional
 * name and `profile_completed_at` NULL, and a finished sign-up lands on /welcome (#219), where
 * the member says who they are before reaching the board.
 *
 * Order matters: the attestation is checked before the code is even read, the code before any
 * user is touched, and the person row before anybody is signed in. Since #70 the platform no
 * longer refuses to create a user on its own — *Allow new users to sign up* is ON so that Google
 * sign-up can work (epic #7 decision E, dashboard half reversed 2026-08-23) — so creating the
 * user here is what puts the attestation in its metadata, and that attestation is what
 * `ensurePerson` acts on. An auth user that reaches `ensurePerson` with no attestation and no
 * invite gate behind it is still deleted there (src/auth/person.ts); this path never produces one.
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
  code: string;
  /** The form posts `true` on every create; a request without it is a hand-built one and is refused. */
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
    user_metadata: { adult_attested_at: string };
  }) => Promise<{ created: true; id: string } | { created: false } | { error: string }>;
  /** The auth user already at this address, and whether it carries an attestation (#85). */
  existingUser: (email: string) => Promise<FoundUser>;
  /**
   * Writes this gate's attestation onto an existing UNATTESTED auth user, and sets the password
   * chosen on this submission (#85, extended #82). Only ever called for a stray with no
   * attestation, so setting the password is claiming a squatted address, not overwriting a
   * member's — an already-attested user is refused a line up in `join`.
   */
  attestExisting: (
    id: string,
    meta: { adult_attested_at: string },
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
 * `then: "signin"` puts them on the Sign in tab, which carries the Forgot link. Until #204 that was
 * the way out for the one population this could strand: an attested auth user with a password and
 * NO person row — a member who signed up before #99 and never opened their emailed link, or a
 * sign-up interrupted between its two writes — for whom signing in answered NOT_A_MEMBER and
 * signing up answered this. Since #204 signing up finishes them instead (`finishInterrupted`), so
 * this answer means what it says: the row exists.
 */
export const ALREADY_A_MEMBER = "You already have an account here — sign in with your password.";

/** The account exists and the sign-in that should have followed it did not (#99 AC 3). */
export const CREATED_NOT_SIGNED_IN =
  "Your account is set up, but signing you in did not work. Sign in with the email and password you just chose.";

/**
 * Where a finished sign-up lands: /welcome, "Finish your profile" (#219), since #220 — the row
 * was minted with a provisional name and the member has not said who they are yet. A constant,
 * never a caller's value. A Google sign-up by someone who already holds a person row is a
 * sign-in, not a sign-up, and lands on the board as one does.
 */
export const AFTER_SIGNUP = WELCOME_PATH;

/**
 * A wrong invite code's answer, at both gates. Since #206 it is also what a caller gets when the
 * attempt limit refuses them (`src/auth/attempt-limit.ts`), which is why it is one value and not
 * two literals: the limit is not an oracle only while the two answers cannot differ.
 */
export const WRONG_CODE = { status: 403, body: { message: "That invite code is not this season's." } } as const;

/**
 * Whether the code a person typed is this season's. NFKC folds a fullwidth or pasted look-alike to
 * its plain form, `trim` drops the spaces a copy picks up, and since #243 case is folded on BOTH
 * sides: `rotate_invite_code()` mints capitals only (0035), so `abcd2345` copied off a board is the
 * same code, and a club row seeded by hand in lower case still matches what a member types.
 */
export function codesMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied.normalize("NFKC").trim().toUpperCase());
  const b = Buffer.from(expected.normalize("NFKC").trim().toUpperCase());
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
  if (!EMAIL.test(email)) {
    return { status: 400, body: { message: "Enter a valid email address." } };
  }
  // The password is validated before the code is read, alongside the name and email, so a too-short
  // one is refused before anything is touched — same as every other bad-input case (#82).
  const pw = validatePassword(input.password);
  if (!pw.ok) {
    return { status: 400, body: { message: pw.message } };
  }
  if (!codesMatch(input.code, await deps.inviteCode())) {
    return WRONG_CODE;
  }

  // The attestation only, since #220: the name is given on /welcome, not here.
  const meta = {
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
      // An attested user is a member's account — unless the sign-up that attested it stopped
      // between its two writes and left no person row (#204). `ensurePerson` tells the two apart
      // and is the one that acts: it writes nothing where a row exists, and mints the row where
      // none does. The user's own metadata carries the attestation, so its delete branch cannot
      // be entered from here. See `finishInterrupted` below for the rest.
      const finished = await ensurePerson({ id: existing.id, email, user_metadata: existing.user_metadata }, deps.person);
      if ("refused" in finished) return CANNOT_START;
      if (finished.created) return finishInterrupted(email, input.password, deps);
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

/**
 * The end of a sign-up that stopped between creating the auth user and minting its person row
 * (#204), called once `ensurePerson` has just minted that row.
 *
 * HOW ONE GETS HERE. `createUser` writes the attestation; `ensurePerson` then reads `person` and
 * inserts it. Anything that fails between the two — the platform refusing the service role's read
 * (1 in 477 on 2026-09-22, `JWT issued at future`), an insert error, a function cut off — leaves
 * an attested auth user with no row. Until #204 the member's retry was answered ALREADY_A_MEMBER,
 * the sign-in it pointed at answered NOT_A_MEMBER, and the way out was that sentence's third
 * screen: Forgot my password, whose emailed link mints the row at /auth/callback. Owner decision
 * at pickup, 2026-09-24: the retry itself finishes it. The same holds for the pre-#99 population
 * ALREADY_A_MEMBER's comment describes — attested, a password, never opened their link.
 *
 * THE ROW BEFORE THE SIGN-IN, as on the ordinary path. The row is minted from the auth user's OWN
 * metadata — the attestation a gate already wrote, not this submission's — which is what the
 * callback would mint on a reset, and by this point the same submission has proved this season's
 * code. Then the typed password signs in. A wrong password answers ALREADY_A_MEMBER, which is now
 * simply true, and writes nothing else.
 *
 * WHY NOT SIGN IN FIRST. Signing in first would keep a wrong password from writing anything, and
 * that is exactly what would make this branch a password oracle: a caller holding the code could
 * guess against an unfinished account over and over, and the attempt limit counts only wrong CODES
 * here (#206). Minted first, the branch is reachable once per account — the second request finds
 * the row, `ensurePerson` answers `created: false`, and the gate answers ALREADY_A_MEMBER without
 * trying a password at all.
 */
async function finishInterrupted(email: string, password: string, deps: JoinDeps): Promise<JoinResult> {
  const signedIn = await deps.signIn(email, password);
  if (signedIn.error) return { status: 409, body: { message: ALREADY_A_MEMBER, then: "signin" } };
  return { status: 200, body: { redirect: AFTER_SIGNUP } };
}

// ---------------------------------------------------------------------------------------------
// Sign up finishing with Google (#70 AC 4, moved to the ID-token flow by #173): the same gate,
// a different exit.
//
// The browser has already been to Google — the GIS button on our own origin handed it an ID
// token — and posts the token, the raw nonce, the invite code and the attestation together. So
// the gate checks what it always checked, in the same order, and then does in ONE request what
// the redirect flow spread across two: exchange the token for a session, and mint the person row
// through `ensurePerson` with the attestation from this very submission (and, until #220, the
// name typed beside it). The gate pass — the signed cookie that used to carry those values across
// the Google round trip to /auth/callback — has no round trip to carry them across any more, and
// is gone with its secret.

export type GoogleSignupInput = {
  code: string;
  attested: boolean;
  /** The ID token from GIS and the raw nonce the browser generated for it. */
  credential?: unknown;
  nonce?: unknown;
};

export type GoogleSignupDeps = {
  inviteCode: () => Promise<string>;
  /** `signInWithIdToken` through the cookie-bound client: the session lands on the response. */
  exchange: ExchangeIdToken;
  /** The person store `ensurePerson` writes through — the same one every other caller supplies. */
  person: PersonStore;
  /** Undo the session the exchange wrote, when the person row could not be minted. */
  signOut: () => Promise<void>;
  now?: () => Date;
};

export type GoogleSignupResult =
  | { status: 200; body: { redirect: string } }
  | { status: 400 | 401 | 403 | 500; body: { message: string } };

export async function googleSignup(
  input: GoogleSignupInput,
  deps: GoogleSignupDeps,
): Promise<GoogleSignupResult> {
  if (!input.attested) {
    return { status: 400, body: { message: "You must confirm that you are 18 or over." } };
  }
  // Before the token is present nothing is asked of Supabase, and the code is not read either:
  // a post with no credential is a hand-built one, not a member whose code needs checking.
  if (!hasCredential(input)) return { status: 400, body: { message: NO_CREDENTIAL } };
  if (!codesMatch(input.code, await deps.inviteCode())) {
    return WRONG_CODE;
  }

  // The attestation is stamped at the moment the gate accepted the submission — the same clock
  // the password path reads for `adult_attested_at`.
  const attestedAt = (deps.now ?? (() => new Date()))().toISOString();

  const exchanged = await deps.exchange(input.credential, input.nonce);
  if ("error" in exchanged) return { status: 401, body: { message: NOT_VERIFIED } };

  // One writer, one predicate. A Google-created user carries no attestation of ours, so the gate
  // hands `ensurePerson` the fact this submission proved; a user that already has a person row
  // (a member on the Sign up tab) simply signs in. The delete branch is reachable only when the
  // gate is absent, which from here it never is.
  const ensured = await ensurePerson(exchanged.user, deps.person, { adult_attested_at: attestedAt });
  if ("refused" in ensured) {
    // Nobody is signed in on a refusal: a session with no membership behind it is exactly what
    // the Google sign-in route refuses a moment later, and it would only hide the failure.
    await deps.signOut();
    return CANNOT_START;
  }
  // A row minted just now carries a provisional name, so /welcome; a member who already had one
  // has nothing to finish and lands where a sign-in does.
  return { status: 200, body: { redirect: ensured.created ? AFTER_SIGNUP : SIGNED_IN_HOME } };
}
