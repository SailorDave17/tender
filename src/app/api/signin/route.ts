import { NextResponse, type NextRequest } from "next/server";
import { passwordSignIn } from "@/auth/password";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign in for a returning member (#82): email + password. `signInWithPassword` returns a session
 * directly through the cookie-bound client — the session cookies are written via cookies() and
 * Next merges that store onto this response — so this path never touches /auth/callback.
 *
 * That is exactly why the person-row guard lives here as well as at the callback: with signups ON
 * a confirmed stray can hold a session, and only a person row makes it a membership.
 * `passwordSignIn` refuses a rowless session and signs it back out (AC 7); the read is scoped to
 * the caller's own id and no user is created on this path.
 *
 * The row is minted by `ensurePerson` and by nothing else, but since #99 that is reached from two
 * places rather than one — /auth/callback and the invite gate — so "minted at the callback, never
 * here" is no longer the way to say it. Never HERE is still exact: this route creates nothing.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();

  const result = await passwordSignIn(
    { email: String(body.email ?? ""), password: String(body.password ?? "") },
    {
      authenticate: async (email, password) => {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) return { error: { code: error.code, message: error.message } };
        return { userId: data.user?.id };
      },
      hasPerson: async (userId) => {
        const { data } = await client.from("person").select("id").eq("id", userId).maybeSingle();
        return Boolean(data);
      },
      signOut: async () => {
        await client.auth.signOut();
      },
    },
  );

  return NextResponse.json(result.body, { status: result.status });
}
