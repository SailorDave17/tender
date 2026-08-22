import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/auth/next";
import { ensurePerson } from "@/auth/person";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Where the magic link lands. Exchanges the PKCE code for a session (the cookie-bound client
 * writes the session cookies), makes sure the person rows exist, and redirects to a sanitised
 * `next`. Any failure goes back to /join with a reason the page can show; nothing here ever
 * redirects off this origin (src/auth/next.ts).
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const back = (reason: string) => {
    const url = request.nextUrl.clone();
    url.pathname = "/join";
    url.search = `?error=${encodeURIComponent(reason)}`;
    return NextResponse.redirect(url);
  };
  if (!code) return back("missing-code");

  const client = await supabaseServer();
  const { data, error } = await client.auth.exchangeCodeForSession(code);
  if (error || !data.user) return back("link-invalid");

  const admin = supabaseAdmin();
  const ensured = await ensurePerson(data.user, {
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
  });
  if ("refused" in ensured) return back("not-invited");

  const url = request.nextUrl.clone();
  const target = new URL(next, url.origin);
  url.pathname = target.pathname;
  url.search = target.search;
  url.hash = target.hash;
  return NextResponse.redirect(url);
}
