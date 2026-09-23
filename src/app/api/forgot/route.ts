import { NextResponse, type NextRequest } from "next/server";
import { clientAddress, withAttemptLimit } from "@/auth/attempt-limit";
import { GENERIC_OK, requestReset, type SignInResult } from "@/auth/signin";
import { serviceAttemptStore } from "@/lib/auth/attempt-store";
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

  const attempt = () => requestReset(
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
  // #206: this screen has no failure to count and costs a member an email per request, so every
  // request counts, on a budget of its own per source address. A caller over it gets the same
  // generic sentence, and no mail goes out.
  const result = await withAttemptLimit<SignInResult>({
    gate: "forgot",
    ip: clientAddress(request.headers),
    store: serviceAttemptStore(),
    refusal: { status: 200, body: { message: GENERIC_OK } },
    isFailure: () => true,
    attempt,
  });
  return NextResponse.json(result.body, { status: result.status });
}
