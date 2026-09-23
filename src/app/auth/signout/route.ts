import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Sign out: the cookie-bound client clears the session cookies, then back to /join.
 *
 * Deliberately plain `/join`, not `SIGN_IN_URL` (#234): someone who has just signed out has signed
 * in on this device, so it carries `tender_seen` and `/join` opens on Sign in already (#123). The
 * tab is the device's to decide here. That is the one sign-in redirect where it is not a stranger's.
 */
export async function POST(request: NextRequest) {
  const client = await supabaseServer();
  await client.auth.signOut();
  const url = request.nextUrl.clone();
  url.pathname = "/join";
  url.search = "";
  return NextResponse.redirect(url, { status: 303 });
}
