import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonStore } from "@/auth/person";

/**
 * The person store as the service role writes it — the effects behind `ensurePerson`, which is
 * the only writer of `person` (src/auth/person.ts). Until #173 each caller carried its own copy
 * of these four closures; with a third and a fourth caller (the Google sign-in and sign-up
 * routes) one copy is the difference between one predicate and four that can drift.
 *
 * `/api/join` keeps its own inline copy on purpose: `src/auth/routes-source.test.ts` asserts the
 * shape of that route's deps block (the attestation stamp has exactly one home, the second
 * `updateUserById` writes no password), and those assertions read the route's own text.
 */
export function adminPersonStore(admin: SupabaseClient): PersonStore {
  return {
    exists: async (id) => {
      const { count, error } = await admin
        .from("person")
        .select("id", { count: "exact", head: true })
        .eq("id", id);
      if (error) throw new Error(error.message);
      return (count ?? 0) > 0;
    },
    insert: async (row) => {
      const p = await admin.from("person").insert({
        id: row.id,
        display_name: row.display_name,
        adult_attested_at: row.adult_attested_at,
      });
      if (p.error) return { error: p.error.message };
      const c = await admin.from("person_contact").insert({ person_id: row.id, email: row.email });
      return c.error ? { error: c.error.message } : {};
    },
    setMetadata: async (id, meta) => {
      const { error } = await admin.auth.admin.updateUserById(id, { user_metadata: meta });
      return error ? { error: error.message } : {};
    },
    deleteUser: async (id) => {
      const { error } = await admin.auth.admin.deleteUser(id);
      return error ? { error: error.message } : {};
    },
  };
}
