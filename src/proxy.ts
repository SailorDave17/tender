import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { needsPersonRead, redirectFor, searchFor, standingFromRow, type Standing } from "@/auth/gate";
import { env } from "@/lib/env";

/** The header Next's router puts on a prefetch (next/dist/client/components/app-router-headers). */
const NEXT_ROUTER_PREFETCH = "next-router-prefetch";

/**
 * Runs before every non-asset request: refreshes the session cookie if it is due, sends a
 * request with no signed-in person away from the gated paths, and since #219 sends a member who
 * has not finished their profile to /welcome (src/auth/gate.ts decides which).
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
  const claims = data?.claims;
  const pathname = request.nextUrl.pathname;

  // #219: a signed-in member who has not finished their profile is sent to /welcome, which needs
  // their own person row — one PostgREST read. Next's docs warn off database reads here because
  // the proxy runs on every request, prefetches included, so the read is spent only where the
  // answer depends on it (needsPersonRead: the gated prefixes, /welcome and /join) and never on a
  // router prefetch, whose real navigation comes back through here and is gated then. Everywhere
  // else a session reads as `finished`, which is exactly the old `signedIn = true`.
  let standing: Standing = claims ? "finished" : "signed-out";
  if (claims && needsPersonRead(pathname) && !request.headers.has(NEXT_ROUTER_PREFETCH)) {
    const { data: row, error } = await supabase
      .from("person")
      .select("profile_completed_at")
      .eq("id", claims.sub)
      .maybeSingle();
    standing = standingFromRow(row, error);
  }

  const target = redirectFor(pathname, standing);
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    // #234: the sign-in screen by its tab, and no other query. `target` is a pathname by contract,
    // so the query is set here rather than carried in it; see SIGN_IN_URL for why.
    url.search = searchFor(target);
    // 302, not Next's default 307: a plain "go and sign in" for a GET, and what AC 1 names.
    return NextResponse.redirect(url, 302);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico|webmanifest)$).*)"],
};
