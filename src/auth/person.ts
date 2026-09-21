/**
 * Make sure the person exists in the app's own tables — or, if the auth user should never have
 * existed, remove it.
 *
 * 0002 grants no client role an insert on person or person_contact — the row is created here,
 * by the service role, from what the invite gate put in the auth user's metadata. Idempotent:
 * every sign-in runs it, and only the first one writes.
 *
 * Since #70 there is a second way in: a Google-created auth user carries no attestation in its
 * metadata, so the invite gate hands over what it just proved instead — the name typed and the
 * box ticked on the same submission. With that the attestation is written onto the user and the
 * rows are minted; without it the auth user is deleted — with *Allow new users to sign up* ON,
 * this is the layer that refuses an uninvited account. Until #173 that hand-over was a signed
 * cookie (the gate pass), because the Google redirect put a round trip through Google between
 * the form and the callback that minted the row. The ID-token flow puts the token in the same
 * request as the form, so the gate now passes its attestation as an argument and the cookie,
 * its secret and its TTL are gone.
 *
 * **This stays the only writer of `person`, and it has three callers.** /auth/callback calls it
 * after exchanging a PKCE code — a reset link, or the return leg of an identity link. The invite
 * gate (src/auth/join.ts) calls it directly, for a password sign-up with the metadata it has just
 * written, and for a Google sign-up with the gate attestation below. And the Google sign-in
 * route calls it with neither, which is what makes a Google account matching no member a
 * deleted auth user rather than a session.
 */

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
 * What the invite gate proved on THIS request about a Google-created user: the name they typed
 * and the moment they ticked 18+. It exists only for the one hop from the gate to the store —
 * never serialised, never signed, never on a cookie.
 */
export type GateAttestation = {
  display_name: string;
  adult_attested_at: string;
};

export type PersonStore = {
  /** Does a person row exist for this auth user? */
  exists: (id: string) => Promise<boolean>;
  /** Insert person and person_contact in one statement, as the service role. */
  insert: (row: {
    id: string;
    display_name: string;
    adult_attested_at: string;
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
  let displayName = typeof meta.display_name === "string" ? meta.display_name.trim() : "";
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
    const w = await store.setMetadata(user.id, {
      display_name: gate.display_name,
      adult_attested_at: gate.adult_attested_at,
    });
    if (w.error) return { created: false, refused: w.error, deleted: false };
    displayName = gate.display_name.trim();
    attested = gate.adult_attested_at;
    usedGate = true;
  }
  if (!email) return { created: false, refused: "auth user has no email", deleted: false };

  const r = await store.insert({
    id: user.id,
    display_name: displayName || email.split("@")[0],
    adult_attested_at: attested,
    email,
  });
  if (r.error) return { created: false, refused: r.error, deleted: false };
  return { created: true, usedGate };
}
