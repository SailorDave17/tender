import { explainReason } from "./callback";
import { ensurePerson, type AuthUser, type PersonStore } from "./person";

/**
 * Sign in with Google for a returning member, on the ID-token flow (#173).
 *
 * The browser obtains an ID token from Google Identity Services on OUR origin — so the only
 * Google screen a member sees is bound to tender.madcowsailing.com, which is the whole reason
 * this flow replaced the redirect through `<ref>.supabase.co/auth/v1/authorize` (#77) — and posts
 * it here with the raw nonce. The route exchanges the pair through the cookie-bound client, and
 * the session lands on the response the way a password sign-in's does (src/auth/password.ts).
 * Nothing leaves this origin by redirect, and /auth/callback is not involved.
 *
 * Then the same admission rule the callback applied to the redirect flow, and it is the same
 * function: `ensurePerson` with no gate. A person row admits; the email gate's metadata on the
 * user mints one; a Google account that matches neither is a stray, deleted, and told what the
 * callback told it — `explainReason("not-invited")`, one sentence in one place.
 *
 * Pure over injected effects, so the two negative claims are unit tests: no Supabase call is
 * made before the token is present, and the stray branch deletes once and inserts never.
 */

export type GoogleSignInInput = {
  /** The ID token GIS handed the browser (`CredentialResponse.credential`). */
  credential: string;
  /** The RAW nonce the browser generated; GIS was given its SHA-256 hex, and Supabase compares. */
  nonce: string;
};

export type ExchangeError = { code?: string; message: string };

/** `signInWithIdToken` through the cookie-bound client: a user with a session, or why not. */
export type ExchangeIdToken = (
  credential: string,
  nonce: string,
) => Promise<{ user: AuthUser } | { error: ExchangeError }>;

export type GoogleSignInDeps = {
  exchange: ExchangeIdToken;
  /** The person store `ensurePerson` writes through — the same one /auth/callback supplies. */
  person: PersonStore;
  /** Undo the session the exchange wrote, when the user behind it was refused. */
  signOut: () => Promise<void>;
};

export type GoogleSignInResult =
  | { status: 200; body: { redirect: string } }
  | { status: 400 | 401 | 403; body: { message: string } };

/** Where a Google sign-in lands. A constant, never a caller's value. */
export const AFTER_GOOGLE_SIGNIN = "/board";

/** Nothing usable came from Google — the button's callback never ran, or the post was hand-built. */
export const NO_CREDENTIAL = "Google did not hand over a sign-in. Try the Google button again.";

/**
 * Supabase refused the token. The commonest real cause is the nonce: the token's nonce claim is
 * the SHA-256 of what the browser generated, and the raw value posted with it must hash to the
 * same thing (*Skip nonce checks* is OFF on the provider, deliberately). Every refusal answers
 * the SAME sentence — a token Supabase will not accept is not a member's problem to diagnose,
 * and the detail is in the function log.
 */
export const NOT_VERIFIED =
  "Google signed you in, but the sign-in could not be verified here. Try again — if it keeps happening, sign in with your email and password.";

export function hasCredential(input: { credential?: unknown; nonce?: unknown }): input is GoogleSignInInput {
  return (
    typeof input.credential === "string" &&
    input.credential.length > 0 &&
    typeof input.nonce === "string" &&
    input.nonce.length > 0
  );
}

export async function googleSignIn(
  input: { credential?: unknown; nonce?: unknown },
  deps: GoogleSignInDeps,
): Promise<GoogleSignInResult> {
  // Before the token is present nothing is asked of Supabase — a bare POST is answered from here.
  if (!hasCredential(input)) return { status: 400, body: { message: NO_CREDENTIAL } };

  const exchanged = await deps.exchange(input.credential, input.nonce);
  if ("error" in exchanged) return { status: 401, body: { message: NOT_VERIFIED } };

  const ensured = await ensurePerson(exchanged.user, deps.person);
  if ("refused" in ensured) {
    // The exchange wrote a session for a user that no longer (or never should) exist.
    await deps.signOut();
    return { status: 403, body: { message: explainReason("not-invited") } };
  }
  return { status: 200, body: { redirect: AFTER_GOOGLE_SIGNIN } };
}
