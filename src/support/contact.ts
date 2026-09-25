import "server-only";
import { cache } from "react";
import { after, connection } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { reportErrorLive } from "@/notify/error-live";
import { contactFromRead, type SupportAddressRead, type SupportContact } from "./contact-read";

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
 * anyone has decided who the admin is"), so the page says in words who to ask instead.
 *
 * A REFUSED READ DOES NOT THROW (#204). Until then it did, and this header justified it by the
 * theme: the layout read the same row first, so a database the page could not reach had already
 * failed the whole render. #198 took that away — the theme's refusal now paints the default and
 * the layout renders — so this read was the one thing left failing /support, the page meant for
 * people who are stuck. A refusal now renders the page with a sentence saying the address could
 * not be loaded, and is reported to the owner after the response. `./contact-read.ts` holds the
 * rule and says why; this file only does the I/O, and a query that throws rather than answering
 * an error is treated as the same refusal. A missing service key still throws, in
 * `supabaseAdmin()`, before any read: that is configuration, not a transient refusal (#65).
 */
export const loadSupportAddress = cache(async (): Promise<SupportContact> => {
  await connection();
  const admin = supabaseAdmin();
  let read: SupportAddressRead;
  try {
    read = await admin.from("club").select("admin_email").limit(1).maybeSingle();
  } catch (e) {
    read = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
  return contactFromRead(read, (report) => after(() => reportErrorLive(report)));
});
