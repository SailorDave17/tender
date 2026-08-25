import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { decideCallback } from "@/auth/callback";
import { LINK_DONE, backPathFor, isLinkFlow } from "@/auth/link";
import { safeNext } from "@/auth/next";
import { PASS_COOKIE, verifyPass } from "@/auth/pass";
import { ensurePerson } from "@/auth/person";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Where the magic link and the Google redirect both land. Exchanges the PKCE code for a session
 * (the cookie-bound client writes the session cookies), makes sure the person rows exist — or,
 * for a Google-created user with no gate pass, deletes the auth user and the session (#70) —
 * and redirects to a sanitised `next`. Any failure goes back to a reason the page can show;
 * nothing here ever redirects off this origin (src/auth/next.ts).
 *
 * Since #74 there is a third leg: the return from `linkIdentity`, marked `flow=link`. It differs
 * only in where it lands — a member who was already signed in and linking must not be dropped on
 * /join and told to sign in. `ensurePerson` is reached with a person row that already exists, so
 * it writes nothing; the delete branch is unreachable on this leg by construction.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const next = safeNext(q.get("next"));
  const flow = q.get("flow");
  // The pass is single-use: clear it on every exit. Through the cookie STORE, not the response —
  // exchangeCodeForSession writes the session cookies via cookies(), and Next merges that store
  // onto the response over any Set-Cookie the handler put there itself (measured 2026-08-23: a
  // response-level clear survived the error path and vanished on the success path).
  const pass = verifyPass(request.cookies.get(PASS_COOKIE)?.value, process.env.GATE_PASS_SECRET ?? "");
  (await cookies()).set(PASS_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
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

  const admin = supabaseAdmin();
  const ensured = await ensurePerson(
    data.user,
    {
      exists: async (id) => {
        const { count, error: e } = await admin
          .from("person")
          .select("id", { count: "exact", head: true })
          .eq("id", id);
        if (e) throw new Error(e.message);
        return (count ?? 0) > 0;
      },
      insert: async (row) => {
        const p = await admin.from("person").insert({
          id: row.id,
          display_name: row.display_name,
          adult_attested_at: row.adult_attested_at,
        });
        if (p.error) return { error: p.error.message };
        const c = await admin.from("person_contact").insert({ person_id: row.id, email: row.email });
        return c.error ? { error: c.error.message } : {};
      },
      setMetadata: async (id, meta) => {
        const { error: e } = await admin.auth.admin.updateUserById(id, { user_metadata: meta });
        return e ? { error: e.message } : {};
      },
      deleteUser: async (id) => {
        const { error: e } = await admin.auth.admin.deleteUser(id);
        return e ? { error: e.message } : {};
      },
    },
    pass,
  );
  if ("refused" in ensured) {
    // The session cookies were just written for a user that no longer (or never should) exist.
    await client.auth.signOut().catch(() => undefined);
    return back("not-invited");
  }

  const url = request.nextUrl.clone();
  // A link that succeeded lands back on the profile carrying the marker that page confirms on,
  // whatever `next` says — the only place a link can sensibly finish.
  const target = new URL(isLinkFlow(flow) ? LINK_DONE : next, url.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  return NextResponse.redirect(url);
}
