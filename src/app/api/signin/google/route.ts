import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { googleSignIn } from "@/auth/google-signin";
import { rememberDevice } from "@/auth/recognition";
import { exchangeGoogleIdToken } from "@/lib/auth/google";
import { adminPersonStore } from "@/lib/auth/person-store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign in with Google for a returning member on the ID-token flow (#173). Replaces
 * `GET /auth/google`, which sent the browser through `<ref>.supabase.co/auth/v1/authorize` and
 * so put the Supabase host on every Google screen (#77). The browser now brings the ID token
 * here, and the only Supabase sign-in call this route makes is `signInWithIdToken`.
 *
 * The decision is `src/auth/google-signin.ts`; this file wires the cookie-bound exchange, the
 * service-role person store, and the device marker. The session cookies are written by
 * `signInWithIdToken` through `cookies()`, and Next merges that store onto this response — the
 * same shape as /api/signin, and the same reason the marker goes through the store.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const client = await supabaseServer();

  const result = await googleSignIn(
    { credential: body.credential, nonce: body.nonce },
    {
      exchange: (token, nonce) => exchangeGoogleIdToken(client, token, nonce),
      person: adminPersonStore(supabaseAdmin()),
      signOut: async () => {
        await client.auth.signOut().catch(() => undefined);
      },
    },
  );

  // #123: this device has now signed in. 200 only — the 403 arm has just signed the session back
  // out, and a device that was refused is not a device that signed in.
  if (result.status === 200) rememberDevice(await cookies(), request.nextUrl.protocol === "https:");

  return NextResponse.json(result.body, { status: result.status });
}
