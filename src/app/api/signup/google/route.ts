import { NextResponse, type NextRequest } from "next/server";
import { googleSignup } from "@/auth/join";
import { PASS_COOKIE, PASS_TTL_MS, signPass } from "@/auth/pass";
import { startGoogle } from "@/lib/auth/google";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { env, supabaseServer } from "@/lib/supabase/server";

/**
 * Sign up finishing with Google (#70 AC 4). The decision is src/auth/join.ts `googleSignup`;
 * this file wires the invite code read as the service role, the gate pass as an HttpOnly
 * cookie signed with GATE_PASS_SECRET, and the OAuth start through the cookie-bound client.
 * Answers JSON `{url}` — the form sends the browser there — so a refusal stays a JSON message.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const admin = supabaseAdmin();
  const client = await supabaseServer();
  const secret = env("GATE_PASS_SECRET");
  let passToken: string | null = null;

  const result = await googleSignup(
    {
      displayName: String(body.displayName ?? ""),
      code: String(body.code ?? ""),
      attested: body.attested === true,
    },
    {
      inviteCode: async () => {
        const { data, error } = await admin.from("club").select("invite_code").limit(1).single();
        if (error || !data) throw new Error(`club row unreadable: ${error?.message ?? "no row"}`);
        return data.invite_code as string;
      },
      setPass: async (payload) => {
        passToken = signPass(payload, secret);
      },
      startOAuth: () => startGoogle(client, request.nextUrl.origin),
    },
  );

  const res = NextResponse.json(result.body, { status: result.status });
  if (result.status === 200 && passToken) {
    res.cookies.set(PASS_COOKIE, passToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/auth/callback",
      maxAge: PASS_TTL_MS / 1000,
    });
  }
  return res;
}
