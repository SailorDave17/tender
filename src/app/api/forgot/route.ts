import { NextResponse, type NextRequest } from "next/server";
import { requestReset } from "@/auth/signin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The Forgot-my-password screen's one arm (#82 AC 4, narrowed by #99): a password-reset email,
 * `resetPasswordForEmail`, landing on /reset-password through the callback (PKCE `code` → session
 * → set the new password).
 *
 * It had two until #99, keyed on an `action` in the body — the second was the magic link, and it
 * is gone. The `action` key goes with it: one arm needs no selector, and a selector left behind is
 * a branch nothing reaches. Requests that still carry `action: "link"` get the reset, which is the
 * only thing this screen now offers and what its one button asks for.
 *
 * It sends only for a registered address and answers the same generic sentence either way, so it
 * does not reveal whether an address has an account.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();
  const origin = request.nextUrl.origin;

  const result = await requestReset(
    { email: String(body.email ?? "") },
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
