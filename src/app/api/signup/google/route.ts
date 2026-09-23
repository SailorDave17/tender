import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { clientAddress, withAttemptLimit } from "@/auth/attempt-limit";
import { WRONG_CODE, googleSignup, type GoogleSignupResult } from "@/auth/join";
import { rememberDevice } from "@/auth/recognition";
import { adminAttemptStore } from "@/lib/auth/attempt-store";
import { exchangeGoogleIdToken } from "@/lib/auth/google";
import { adminPersonStore } from "@/lib/auth/person-store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign up finishing with Google (#70 AC 4), on the ID-token flow since #173. The decision is
 * src/auth/join.ts `googleSignup`; this file wires the invite code read as the service role, the
 * token exchange through the cookie-bound client, and the person store. The browser posts the
 * invite code and the attestation AND the ID token together, so the code and the attestation are
 * checked, the token exchanged and the person row minted in one request — there is no redirect,
 * no gate-pass cookie and no callback leg on this path any more. Answers JSON: `{redirect}` on
 * success, the session already on the response; a refusal stays a JSON message. Since #220 no
 * name is posted: the row's `display_name` is provisional and the member is sent to /welcome.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const admin = supabaseAdmin();
  const client = await supabaseServer();

  const attempt = () => googleSignup(
    {
      code: String(body.code ?? ""),
      attested: body.attested === true,
      credential: body.credential,
      nonce: body.nonce,
    },
    {
      inviteCode: async () => {
        const { data, error } = await admin.from("club").select("invite_code").limit(1).single();
        if (error || !data) throw new Error(`club row unreadable: ${error?.message ?? "no row"}`);
        return data.invite_code as string;
      },
      exchange: (token, nonce) => exchangeGoogleIdToken(client, token, nonce),
      person: adminPersonStore(admin),
      signOut: async () => {
        await client.auth.signOut().catch(() => undefined);
      },
    },
  );

  // #206: this gate checks the code before the token is exchanged, so a junk credential is enough
  // to guess with, and it shares the source address's budget with /api/join and /api/signin. No
  // email key: there is no address until the exchange, which a wrong code never reaches.
  const result = await withAttemptLimit<GoogleSignupResult>({
    gate: "signup-google",
    ip: clientAddress(request.headers),
    store: adminAttemptStore(admin),
    refusal: WRONG_CODE,
    isFailure: (r) => r.status === WRONG_CODE.status,
    attempt,
  });

  // #123: a finished sign-up is a session on this device. Through the store, 200 only — as
  // /api/join does, and for the same reason.
  if (result.status === 200) rememberDevice(await cookies(), request.nextUrl.protocol === "https:");

  return NextResponse.json(result.body, { status: result.status });
}
