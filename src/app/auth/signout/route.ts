import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** Sign out: the cookie-bound client clears the session cookies, then back to /join. */
export async function POST(request: NextRequest) {
  const client = await supabaseServer();
  await client.auth.signOut();
  const url = request.nextUrl.clone();
  url.pathname = "/join";
  url.search = "";
  return NextResponse.redirect(url, { status: 303 });
}
