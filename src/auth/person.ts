/**
 * Make sure the person exists in the app's own tables — or, if the auth user should never have
 * existed, remove it.
 *
 * 0002 grants no client role an insert on person or person_contact — the row is created here,
 * by the service role, from what the invite gate put in the auth user's metadata. Idempotent:
 * every sign-in runs it, and only the first one writes.
 *
 * Since #70 there is a second way in: a Google-created auth user carries no attestation in its
 * metadata, so the invite gate hands over what it just proved instead — the 18+ confirmation on
 * the same submission (and, until #220, the name typed beside it). With that the attestation is
 * written onto the user and the rows are minted; without it the auth user is deleted — with
 * *Allow new users to sign up* ON, this is the layer that refuses an uninvited account. Until
 * #173 that hand-over was a signed cookie (the gate pass), because the Google redirect put a
 * round trip through Google between the form and the callback that minted the row. The ID-token
 * flow puts the token in the same request as the form, so the gate now passes its attestation
 * as an argument and the cookie, its secret and its TTL are gone.
 *
 * Since #220 the sign-up form asks for no name. The row is minted with a PROVISIONAL
 * `display_name` (`provisionalName` below) and `profile_completed_at` written as an explicit
 * NULL — 0031's `default now()` would otherwise stamp the member finished — so the proxy sends
 * them to /welcome, where they give their real name (#219).
 *
 * **This stays the only writer of `person`, and it has three callers.** /auth/callback calls it
 * after exchanging a PKCE code — a reset link, or the return leg of an identity link. The invite
 * gate (src/auth/join.ts) calls it directly, for a password sign-up with the metadata it has just
 * written, and for a Google sign-up with the gate attestation below. And the Google sign-in
 * route calls it with neither, which is what makes a Google account matching no member a
 * deleted auth user rather than a session.
 */

import { NAME_MAX } from "@/profile/welcome";

/**
 * Does this auth user's metadata carry a usable attestation?
 *
 * Two callers must answer this identically. `ensurePerson` below deletes an auth user that has
 * no attestation and no gate attestation; the invite gate (src/auth/join.ts) writes an
 * attestation onto an *existing* user precisely when that would otherwise happen (#85). A
 * difference between the two predicates is either a member deleted after being told they were
 * in, or a write that never needed to happen — so there is one function and both sides call it.
 *
 * It returns the attestation rather than a boolean because `ensurePerson` needs the value while
 * the gate needs only its presence; a boolean here would put the parsing back in two places.
 */
export function attestationOf(meta: Record<string, unknown> | null | undefined): string | null {
  const raw = meta?.adult_attested_at;
  if (typeof raw !== "string" || !raw || Number.isNaN(Date.parse(raw))) return null;
  return raw;
}

export type AuthUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

/**
 * The name a freshly minted member is given until they say who they are on /welcome (#220).
 *
 * In order: a `display_name` the email gate wrote before #220 (a member from then who never got a
 * row — the population #99 could strand); the given name Google sends, or failing that the whole
 * name it sends under either of the two keys GoTrue has used; and last the address's local part,
 * which is what this function's one caller fell back to before #220. Cut to `NAME_MAX` because
 * 0002's check on `display_name` refuses anything longer, and a refused insert here is a member
 * told "could not finish signing up" over a name they never typed.
 *
 * Exported so the fallback order is a test's subject and not only this comment's.
 */
export function provisionalName(meta: Record<string, unknown> | null | undefined, email: string): string {
  for (const key of ["display_name", "given_name", "name", "full_name"]) {
    const v = meta?.[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, NAME_MAX);
  }
  return email.split("@")[0].slice(0, NAME_MAX);
}

/**
 * What the invite gate proved on THIS request about a Google-created user: the moment they
 * confirmed they are 18 or over by creating the account. It exists only for the one hop from the
 * gate to the store — never serialised, never signed, never on a cookie. Until #220 it also
 * carried the name typed on the sign-up form; the form no longer asks.
 */
export type GateAttestation = {
  adult_attested_at: string;
};

export type PersonStore = {
  /** Does a person row exist for this auth user? */
  exists: (id: string) => Promise<boolean>;
  /**
   * Insert person and person_contact in one statement, as the service role. `profile_completed_at`
   * is typed `null` rather than optional so that no writer can leave it to 0031's default by
   * omission: a store that does not forward it is what `src/auth/person-writers.test.ts` reddens.
   */
  insert: (row: {
    id: string;
    display_name: string;
    adult_attested_at: string;
    profile_completed_at: null;
    email: string;
  }) => Promise<{ error?: string }>;
  /** Write the gate's attestation onto the auth user, as the service role (#70). */
  setMetadata: (id: string, meta: GateAttestation) => Promise<{ error?: string }>;
  /** Delete an auth user that arrived with no attestation and no gate, as the service role (#70). */
  deleteUser: (id: string) => Promise<{ error?: string }>;
};

export type EnsureResult =
  | { created: false }
  | { created: true; usedGate: boolean }
  | { created: false; refused: string; deleted: boolean };

export async function ensurePerson(
  user: AuthUser,
  store: PersonStore,
  gate: GateAttestation | null = null,
): Promise<EnsureResult> {
  if (await store.exists(user.id)) return { created: false };

  const meta = user.user_metadata ?? {};
  let attested = attestationOf(meta) ?? "";
  const email = (user.email ?? "").trim().toLowerCase();
  let usedGate = false;

  // A user with no attestation in its metadata did not come through the email gate. The Google
  // gate hands over what it proved instead; with that, the attestation it carries becomes the
  // user's. With neither, refuse to mint a person row AND delete the auth user — adults-only is
  // structural (0002), this is the only writer, and with signups ON nothing upstream refused it.
  if (!attested) {
    if (!gate) {
      const d = await store.deleteUser(user.id);
      return {
        created: false,
        refused: "no adult attestation on the auth user and no invite gate behind it",
        deleted: !d.error,
      };
    }
    const w = await store.setMetadata(user.id, { adult_attested_at: gate.adult_attested_at });
    if (w.error) return { created: false, refused: w.error, deleted: false };
    attested = gate.adult_attested_at;
    usedGate = true;
  }
  if (!email) return { created: false, refused: "auth user has no email", deleted: false };

  const r = await store.insert({
    id: user.id,
    display_name: provisionalName(meta, email),
    adult_attested_at: attested,
    // #220: a member minted here has not said who they are yet. 0031's `default now()` would
    // otherwise stamp the row finished, so the NULL is decided here and written by every store.
    profile_completed_at: null,
    email,
  });
  if (r.error) return { created: false, refused: r.error, deleted: false };
  return { created: true, usedGate };
}
