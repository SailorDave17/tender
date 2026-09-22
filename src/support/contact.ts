import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The address /support tells a member to write to: `club.admin_email`, read on every request
 * (story #147 AC 1).
 *
 * WHY THE CLUB ROW AND NOT A LITERAL. The repo is public, and the owner's address is personal
 * data here like anyone's (the overlay's rule for issue comments, applied to source). Owner
 * decision at pickup, 2026-09-21: read the address the owner already seeds on the club row — the
 * one 0009 uses to decide who the admin is — so nothing personal is committed, and a new admin is
 * the page's contact the moment the row says so.
 *
 * THIS PUBLISHES A COLUMN NO CLIENT ROLE MAY READ. 0009 left `admin_email` out of 0002's column
 * grant on `club`, and nothing here changes that: the read is the SERVICE ROLE's, like
 * `src/brand/club-theme.ts`, because /support is a signed-out page and `anon` reaches nothing in
 * this database by design (0015). Putting the address on a public page is the decision, and it
 * was the owner's; this loader hands back that one column and nothing else from the row.
 *
 * `connection()` first, for club-theme.ts's reason: `next build` must not evaluate this for a
 * static route, where `env()` would throw on CI. `cache()` dedupes within one request.
 *
 * NULL IS A STATE, NOT AN ERROR. 0009 made the column nullable ("a club row may exist before
 * anyone has decided who the admin is"), so the page says in words who to ask instead. A read
 * that FAILS throws, as the theme's does: the layout has already read the same row by then, so a
 * database the page cannot reach has already failed the whole render.
 */
export const loadSupportAddress = cache(async (): Promise<string | null> => {
  await connection();
  const { data, error } = await supabaseAdmin().from("club").select("admin_email").limit(1).maybeSingle();
  if (error) throw new Error(`support address could not be read: ${error.message}`);
  const value = data?.admin_email;
  return typeof value === "string" && value.trim() ? value.trim() : null;
});
