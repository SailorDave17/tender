import { cookies } from "next/headers";
import { NextResponse, after, type NextRequest } from "next/server";
import { UNCONFIRMED, callbackUnconfirmedReport, decideCallback } from "@/auth/callback";
import { LINK_DONE, backPathFor, isLinkFlow } from "@/auth/link";
import { safeNext } from "@/auth/next";
import { ensurePerson } from "@/auth/person";
import { rememberDevice } from "@/auth/recognition";
import { adminPersonStore } from "@/lib/auth/person-store";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { reportErrorLive } from "@/notify/error-live";

/**
 * Where the emailed reset link lands, and where the return leg of an identity link (#74,
 * `flow=link`) lands. Two legs, down from four: the magic link went with #99, and the Google
 * sign-in and sign-up redirects went with #173 — both finish on our own origin now, with the ID
 * token posted to a route, so no Google flow comes back here except the link. Exchanges the
 * PKCE code for a session (the cookie-bound client writes the session cookies), makes sure the
 * person rows exist — or, for an auth user with no attestation, deletes it (#70) — and redirects
 * to a sanitised `next`. Any failure goes back to a reason the page can show; nothing here ever
 * redirects off this origin (src/auth/next.ts).
 *
 * The link leg differs only in where it lands — a member who was already signed in and linking
 * must not be dropped on /join and told to sign in. `ensurePerson` is reached with a person row
 * that already exists, so it writes nothing; the delete branch is unreachable on this leg by
 * construction.
 *
 * Until #173 this handler also verified a gate pass — the signed cookie that carried a Google
 * sign-up's name and attestation across the redirect. That leg and its secret are gone; the
 * `ensurePerson` call below takes no gate, which is exactly the rule that deletes a stray.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const next = safeNext(q.get("next"));
  const flow = q.get("flow");
  const back = (reason: string) => {
    const url = request.nextUrl.clone();
    url.pathname = backPathFor(flow);
    url.search = `?error=${encodeURIComponent(reason)}`;
    return NextResponse.redirect(url);
  };

  const decision = decideCallback({
    code: q.get("code"),
    error: q.get("error"),
    error_code: q.get("error_code"),
    error_description: q.get("error_description"),
  });
  if (decision.kind === "back") return back(decision.reason);

  const client = await supabaseServer();
  const { data, error } = await client.auth.exchangeCodeForSession(decision.code);
  if (error || !data.user) return back("link-invalid");

  // #204: `ensurePerson` begins with a service-role read of `person`, and a refused read throws
  // rather than answering "no row" — the safe direction, since "no row" would send a real member
  // down the delete branch. It used to throw out of this handler too, past the promise above that
  // any failure goes back to a reason, so a reset link landed on a bare 500 with its code spent.
  // Now it goes back with a reason and is reported after the response. `src/auth/callback.ts`
  // (UNCONFIRMED) says why a reset is signed out and a link from /profile is not.
  const store = adminPersonStore(supabaseAdmin());
  let ensured: Awaited<ReturnType<typeof ensurePerson>>;
  try {
    ensured = await ensurePerson(data.user, store);
  } catch (e) {
    const report = callbackUnconfirmedReport(e instanceof Error ? e.message : String(e), isLinkFlow(flow));
    after(() => reportErrorLive(report));
    if (!isLinkFlow(flow)) await client.auth.signOut().catch(() => undefined);
    return back(UNCONFIRMED);
  }
  if ("refused" in ensured) {
    // The session cookies were just written for a user that no longer (or never should) exist.
    await client.auth.signOut().catch(() => undefined);
    return back("not-invited");
  }

  // #123: the exchange above wrote a session on this device, so /join opens on Sign in next time.
  // After the refusal branch, never before it — a stray whose auth user was just deleted and whose
  // session was just signed out has not signed in here. Through the cookie STORE, not the
  // response: exchangeCodeForSession writes the session cookies via cookies(), and Next merges
  // that store onto the response over any Set-Cookie the handler put there itself (measured
  // 2026-08-23: a response-level write survived the error path and vanished on the success path).
  rememberDevice(await cookies(), request.nextUrl.protocol === "https:");

  const url = request.nextUrl.clone();
  // A link that succeeded lands back on the profile carrying the marker that page confirms on,
  // whatever `next` says — the only place a link can sensibly finish.
  const target = new URL(isLinkFlow(flow) ? LINK_DONE : next, url.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  return NextResponse.redirect(url);
}
