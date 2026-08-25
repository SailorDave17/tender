import { NextResponse, type NextRequest } from "next/server";
import { findAuthUser } from "@/auth/find-user";
import { join } from "@/auth/join";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The invite gate. Everything that decides runs in src/auth/join.ts; this file wires the five
 * effects — the invite code read as the service role, the auth user created as the service role,
 * an existing auth user looked up and (when it carries no attestation) stamped with this gate's,
 * both as the service role, and the magic link sent through the cookie-bound client so the PKCE
 * verifier lands in the caller's cookies for /auth/callback to use.
 *
 * Whether to stamp is not decided here — join() decides, this supplies the effect (#85 AC 4).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const admin = supabaseAdmin();
  const client = await supabaseServer();
  const origin = request.nextUrl.origin;

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
        const { error } = await admin.auth.admin.createUser({ ...user, email_confirm: true });
        if (!error) return { created: true };
        // An address that already has a user is not a failure — but it is not necessarily a
        // returning member either, so join() looks at who is there before sending (#85).
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
      sendMagicLink: async (email) => {
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback?next=/board` },
        });
        return error ? { error: error.message } : {};
      },
    },
  );

  return NextResponse.json(result.body, { status: result.status });
}
