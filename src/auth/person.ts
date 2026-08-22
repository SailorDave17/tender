/**
 * After a magic link is exchanged, make sure the person exists in the app's own tables.
 *
 * 0002 grants no client role an insert on person or person_contact — the row is created here,
 * by the service role, from what the invite gate put in the auth user's metadata. Idempotent:
 * every sign-in runs it, and only the first one writes.
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
};

export type EnsureResult =
  | { created: false }
  | { created: true }
  | { created: false; refused: string };

export async function ensurePerson(user: AuthUser, store: PersonStore): Promise<EnsureResult> {
  if (await store.exists(user.id)) return { created: false };

  const meta = user.user_metadata ?? {};
  const displayName = typeof meta.display_name === "string" ? meta.display_name.trim() : "";
  const attested = typeof meta.adult_attested_at === "string" ? meta.adult_attested_at : "";
  const email = (user.email ?? "").trim().toLowerCase();

  // A user with no attestation in its metadata did not come through the invite gate. Refuse to
  // mint a person row for it — adults-only is structural (0002) and this is the only writer.
  if (!attested || Number.isNaN(Date.parse(attested))) {
    return { created: false, refused: "no adult attestation on the auth user" };
  }
  if (!email) return { created: false, refused: "auth user has no email" };

  const r = await store.insert({
    id: user.id,
    display_name: displayName || email.split("@")[0],
    adult_attested_at: attested,
    email,
  });
  if (r.error) return { created: false, refused: r.error };
  return { created: true };
}
