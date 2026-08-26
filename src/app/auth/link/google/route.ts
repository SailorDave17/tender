import { DEFAULT_COOKIE_OPTIONS } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { LINK_PATH, decideLinkStart, restoreVerifiers, verifierCookies } from "@/auth/link";
import { startGoogleLink } from "@/lib/auth/google";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Link a Google account to the signed-in member's existing account (#74). Reached from the
 * control on /profile.
 *
 * A GET route the page links to, matching src/app/auth/google/route.ts — the browser has to
 * leave the origin, so there is nothing for a JSON endpoint to return to.
 *
 * There is deliberately NO session check here. `linkIdentity` sends the session's access token
 * and GoTrue answers 401 `no_authorization` without one, which `decideLinkStart` reads as
 * `not-signed-in` — one mechanism, so the test that covers it names the thing that actually
 * refuses. A second check in front would make either deletable with nothing going red.
 *
 * The snapshot around the call is not defensive tidiness: a refused start leaves a stale PKCE
 * verifier over the one key /auth/callback reads, which kills an emailed link already sitting in the
 * member's inbox — and with *Allow manual linking* off, refusal is the default path.
 * `src/auth/link.ts` carries the measurement. The restore goes through the cookie STORE rather
 * than the response, because Next merges that store over any Set-Cookie a handler sets itself and
 * `supabaseServer()` has already written through it by this point; the options come from
 * `@supabase/ssr`'s own export rather than a copy of them, so they cannot drift.
 */
export async function GET(request: NextRequest) {
  const store = await cookies();
  const client = await supabaseServer();

  const before = verifierCookies(store.getAll());
  const decision = decideLinkStart(await startGoogleLink(client, request.nextUrl.origin));

  if (decision.kind === "redirect") return NextResponse.redirect(decision.url);

  for (const { name, value } of restoreVerifiers(before, verifierCookies(store.getAll()))) {
    if (value === null) store.set(name, "", { ...DEFAULT_COOKIE_OPTIONS, maxAge: 0 });
    else store.set(name, value, DEFAULT_COOKIE_OPTIONS);
  }

  const url = request.nextUrl.clone();
  url.pathname = LINK_PATH;
  url.search = `?error=${encodeURIComponent(decision.reason)}`;
  return NextResponse.redirect(url);
}
