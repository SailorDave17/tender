import { NextResponse, type NextRequest } from "next/server";
import { signIn } from "@/auth/signin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign in for a returning member (#70): email only. No invite code, no service role, no user
 * creation — the one effect is the magic link through the cookie-bound client with
 * shouldCreateUser: false. The decision, including swallowing Supabase's not-a-user refusal,
 * is src/auth/signin.ts.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();
  const origin = request.nextUrl.origin;

  const result = await signIn(
    { email: String(body.email ?? "") },
    {
      sendMagicLink: async (email) => {
        const { error } = await client.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback?next=/board` },
        });
        return error ? { error: { code: error.code, message: error.message } } : {};
      },
    },
  );
  return NextResponse.json(result.body, { status: result.status });
}
