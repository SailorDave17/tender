import { NextResponse, type NextRequest } from "next/server";
import { requestReset, signIn } from "@/auth/signin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The Forgot-my-password screen's two arms (#82 AC 4), behind one endpoint keyed on `action`:
 *
 *   "link"  — the existing sign-in-link flow, unchanged: `signInWithOtp({ shouldCreateUser: false })`
 *             so an unknown address mints no user and spends no send.
 *   "reset" — a password-reset email, `resetPasswordForEmail`, landing on /reset-password through
 *             the callback (PKCE `code` → session → set the new password).
 *
 * Both send only for a registered address and both answer the same generic sentence, so neither
 * reveals whether an address has an account.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();
  const origin = request.nextUrl.origin;
  const email = String(body.email ?? "");

  if (body.action === "reset") {
    const result = await requestReset(
      { email },
      {
        sendReset: async (address) => {
          const { error } = await client.auth.resetPasswordForEmail(address, {
            redirectTo: `${origin}/auth/callback?next=/reset-password`,
          });
          return error ? { error: { message: error.message } } : {};
        },
      },
    );
    return NextResponse.json(result.body, { status: result.status });
  }

  const result = await signIn(
    { email },
    {
      sendMagicLink: async (address) => {
        const { error } = await client.auth.signInWithOtp({
          email: address,
          options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback?next=/board` },
        });
        return error ? { error: { code: error.code, message: error.message } } : {};
      },
    },
  );
  return NextResponse.json(result.body, { status: result.status });
}
