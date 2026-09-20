import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { redirectFor } from "@/auth/gate";
import { env } from "@/lib/env";

/**
 * Runs before every non-asset request: refreshes the session cookie if it is due, and sends a
 * request with no signed-in person away from the gated paths (src/auth/gate.ts decides which).
 *
 * Next 16 calls this `proxy`; the `middleware` convention is deprecated. getClaims() verifies
 * the JWT locally and refreshes it when expired, which is what keeps a session alive across
 * Server Components, which cannot write cookies themselves.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  // env(), not `process.env.X!` — the non-null assertion is a compile-time claim and does
  // nothing at runtime, so a deployment missing one of these got supabase-js's own
  // "supabaseUrl is required" instead of the variable's name (story #65). This is the EARLIEST
  // site either name can be missing at: the proxy runs before every non-asset request, so it
  // throws ahead of the route that would otherwise be blamed.
  const supabase = createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet, headers) {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
          for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const target = redirectFor(request.nextUrl.pathname, Boolean(data?.claims));
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    url.search = "";
    // 302, not Next's default 307: a plain "go and sign in" for a GET, and what AC 1 names.
    return NextResponse.redirect(url, 302);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico|webmanifest)$).*)"],
};
