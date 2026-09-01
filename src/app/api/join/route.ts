import { NextResponse, type NextRequest } from "next/server";
import { findAuthUser } from "@/auth/find-user";
import { join } from "@/auth/join";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The invite gate. Everything that decides runs in src/auth/join.ts; this file wires the effects —
 * the invite code read as the service role, the auth user created as the service role, an existing
 * auth user looked up and (when it carries no attestation) stamped with this gate's, the person
 * store `ensurePerson` writes through, and the password sign-in through the cookie-bound client so
 * the session cookies land on this response.
 *
 * Since #99 there is **no mailer here at all**, and `email_confirm: true` is what keeps the
 * platform from adding one: without it GoTrue sends its own confirmation mail on every
 * `createUser`. That flag is the second half of "no email is sent anywhere on this path" — the
 * first half is that join()'s deps carry nothing that could send one — and it is guarded in
 * `src/auth/routes-source.test.ts`, because no unit test reads a route.
 *
 * The person store is byte-for-byte the callback's, deliberately: two writers of `person` would be
 * two chances to disagree about what a row is. Whether to stamp an existing user is not decided
 * here either — join() decides, this supplies the effect (#85 AC 4).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const admin = supabaseAdmin();
  const client = await supabaseServer();

  const result = await join(
    {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      code: String(body.code ?? ""),
      attested: body.attested === true,
      password: String(body.password ?? ""),
    },
    {
      inviteCode: async () => {
        const { data, error } = await admin.from("club").select("invite_code").limit(1).single();
        if (error || !data) throw new Error(`club row unreadable: ${error?.message ?? "no row"}`);
        return data.invite_code as string;
      },
      createUser: async (user) => {
        const { data, error } = await admin.auth.admin.createUser({ ...user, email_confirm: true });
        if (!error) {
          // No id means no person row can be minted; treat it as a failure rather than guessing.
          return data.user?.id ? { created: true, id: data.user.id } : { error: "created user has no id" };
        }
        // An address that already has a user is not a failure — but it is not necessarily a
        // returning member either, so join() looks at who is there before deciding (#85).
        if (error.code === "email_exists") return { created: false };
        return { error: error.message };
      },
      existingUser: (email) =>
        findAuthUser(email, async (page, perPage) => {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
          if (error) return { error: error.message };
          return { users: data.users };
        }),
      attestExisting: async (id, meta, password) => {
        const { error } = await admin.auth.admin.updateUserById(id, { user_metadata: meta, password });
        return error ? { error: error.message } : {};
      },
      person: {
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
      },
      signIn: async (email, password) => {
        const { error } = await client.auth.signInWithPassword({ email, password });
        return error ? { error: error.message } : {};
      },
    },
  );

  return NextResponse.json(result.body, { status: result.status });
}
