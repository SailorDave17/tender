import type { PassPayload } from "./pass";

/**
 * Make sure the person exists in the app's own tables — or, if the auth user should never have
 * existed, remove it.
 *
 * 0002 grants no client role an insert on person or person_contact — the row is created here,
 * by the service role, from what the invite gate put in the auth user's metadata. Idempotent:
 * every sign-in runs it, and only the first one writes.
 *
 * Since #70 there is a second way in: a Google-created auth user carries no attestation in its
 * metadata, so the invite gate hands the browser a signed gate pass instead (src/auth/pass.ts).
 * With a valid pass the attestation is written onto the user and the rows are minted; without
 * one the auth user is deleted — with *Allow new users to sign up* ON, this is the layer that
 * refuses an uninvited account.
 *
 * **This stays the only writer of `person`, and since #99 it has two callers.** /auth/callback
 * calls it after exchanging a PKCE code — a reset link, or a Google redirect. The invite gate
 * (src/auth/join.ts) calls it directly, with no round trip at all: what authorises that is the
 * submission it is holding, which proved this season's invite code and ticked 18+, the same two
 * facts an emailed link used to carry back. It passes the metadata it has just written, so the
 * delete branch below is unreachable from the gate by construction.
 */

/**
 * Does this auth user's metadata carry a usable attestation?
 *
 * Two callers must answer this identically. `ensurePerson` below deletes an auth user that has
 * no attestation and no gate pass; the invite gate (src/auth/join.ts) writes an attestation onto
 * an *existing* user precisely when that would otherwise happen (#85). A difference between the
 * two predicates is either a member deleted after being told a link was on its way, or a write
 * that never needed to happen — so there is one function and both sides call it.
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
  setMetadata: (
    id: string,
    meta: { display_name: string; adult_attested_at: string },
  ) => Promise<{ error?: string }>;
  /** Delete an auth user that arrived with no attestation and no pass, as the service role (#70). */
  deleteUser: (id: string) => Promise<{ error?: string }>;
};

export type EnsureResult =
  | { created: false }
  | { created: true; usedPass: boolean }
  | { created: false; refused: string; deleted: boolean };

export async function ensurePerson(
  user: AuthUser,
  store: PersonStore,
  pass: PassPayload | null = null,
): Promise<EnsureResult> {
  if (await store.exists(user.id)) return { created: false };

  const meta = user.user_metadata ?? {};
  let displayName = typeof meta.display_name === "string" ? meta.display_name.trim() : "";
  let attested = attestationOf(meta) ?? "";
  const email = (user.email ?? "").trim().toLowerCase();
  let usedPass = false;

  // A user with no attestation in its metadata did not come through the email gate. The Google
  // gate hands over a pass instead; with one, the attestation it carries becomes the user's.
  // With neither, refuse to mint a person row AND delete the auth user — adults-only is
  // structural (0002), this is the only writer, and with signups ON nothing upstream refused it.
  if (!attested) {
    if (!pass) {
      const d = await store.deleteUser(user.id);
      return {
        created: false,
        refused: "no adult attestation on the auth user and no gate pass",
        deleted: !d.error,
      };
    }
    const w = await store.setMetadata(user.id, {
      display_name: pass.display_name,
      adult_attested_at: pass.adult_attested_at,
    });
    if (w.error) return { created: false, refused: w.error, deleted: false };
    displayName = pass.display_name.trim();
    attested = pass.adult_attested_at;
    usedPass = true;
  }
  if (!email) return { created: false, refused: "auth user has no email", deleted: false };

  const r = await store.insert({
    id: user.id,
    display_name: displayName || email.split("@")[0],
    adult_attested_at: attested,
    email,
  });
  if (r.error) return { created: false, refused: r.error, deleted: false };
  return { created: true, usedPass };
}
