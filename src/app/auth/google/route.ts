import { NextResponse, type NextRequest } from "next/server";
import { startGoogle } from "@/lib/auth/google";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign in with Google for a returning member (#70): no gate, no pass. The callback admits the
 * user only if a person row already exists or the email gate's metadata is on the user —
 * a Google account that matches no member is deleted there.
 */
export async function GET(request: NextRequest) {
  const client = await supabaseServer();
  const started = await startGoogle(client, request.nextUrl.origin);
  if ("error" in started) {
    const url = request.nextUrl.clone();
    url.pathname = "/join";
    url.search = "?error=provider-error";
    return NextResponse.redirect(url);
  }
  return NextResponse.redirect(started.url);
}
