import type { PassPayload } from "./pass";

/**
 * After a magic link or an OAuth code is exchanged, make sure the person exists in the app's own
 * tables — or, if the auth user should never have existed, remove it.
 *
 * 0002 grants no client role an insert on person or person_contact — the row is created here,
 * by the service role, from what the invite gate put in the auth user's metadata. Idempotent:
 * every sign-in runs it, and only the first one writes.
 *
 * Since #70 there is a second way in: a Google-created auth user carries no attestation in its
 * metadata, so the invite gate hands the browser a signed gate pass instead (src/auth/pass.ts).
 * With a valid pass the attestation is written onto the user and the rows are minted; without
 * one the auth user is deleted — with *Allow new users to sign up* ON, this is the layer that
 * refuses an uninvited account. This stays the only writer of `person`.
 */

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
  let attested = typeof meta.adult_attested_at === "string" ? meta.adult_attested_at : "";
  const email = (user.email ?? "").trim().toLowerCase();
  let usedPass = false;

  // A user with no attestation in its metadata did not come through the email gate. The Google
  // gate hands over a pass instead; with one, the attestation it carries becomes the user's.
  // With neither, refuse to mint a person row AND delete the auth user — adults-only is
  // structural (0002), this is the only writer, and with signups ON nothing upstream refused it.
  if (!attested || Number.isNaN(Date.parse(attested))) {
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
