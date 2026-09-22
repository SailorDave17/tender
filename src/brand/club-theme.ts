import "server-only";
import { cache } from "react";
import { after, connection } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { reportErrorLive } from "@/notify/error-live";
import { themeFromRead, type ClubRead } from "./club-theme-read";

/**
 * The club's two colours, read from the `club` row on every request (story #41 AC 3).
 *
 * `src/app/layout.tsx` sets `--brand-disc` / `--brand-mark` on `<html>` and the viewport's
 * `themeColor` from this; `src/app/manifest.ts` sets `theme_color` from it. So the row is the one
 * source and a pair saved on `/admin/theme` is on every screen at the next request — there is no
 * constant to keep in step, which is the point (`theme.ts`'s header records the constant that
 * used to be here and why it went).
 *
 * READ AS THE SERVICE ROLE, DELIBERATELY. The root layout renders for the signed-out pages too
 * (`/`, `/join`, `/forgot`), and the manifest is fetched by the browser without the session
 * cookie, so neither can read the row as a signed-in person — and `anon` reaches nothing in this
 * database on purpose (0015; `test/anon-grants.test.ts` sweeps every table and function). The
 * alternatives were a definer callable by anon, which would put the first exemption into that
 * sweep, or leaving the signed-out pages and the manifest on a compiled default, which fails the
 * criterion. This is the same shape as `/api/join`, which reads `club.invite_code` as the
 * service role for a signed-out request; the two brand columns are the least sensitive on the
 * row (0002 grants them to every member), so `src/admin/load.ts`'s argument against the service
 * role — the page becoming the sole author of its own authorization — has nothing to bite on:
 * there is no authorization question about a colour that is on the landing page.
 *
 * `connection()` first, so `next build` prerenders nothing through here. Without it the build
 * would evaluate this for every static route (`/_not-found`, say) and `env()` would throw for
 * `SUPABASE_SERVICE_ROLE_KEY` on CI, which has no environment at all. `cache()` dedupes the read
 * within one request — `generateViewport` and the layout both ask.
 *
 * A MISSING ROW THROWS, with the runbook step in the message. The app cannot sign anyone in
 * without the club row (README step 1 measured that on the live project), so a landing page
 * that named the cause is better than one painted in a colour nobody chose. `env()` does the
 * same for a missing key (#65), and for the same reason.
 *
 * A REFUSED READ DOES NOT THROW (#198). It paints the default theme and reports the refusal to the
 * owner after the response, because one transient platform refusal was failing whole pages.
 * `./club-theme-read.ts` holds the rule and says why; this file only does the I/O, and a query
 * that throws rather than answering an error is treated as the same refusal.
 */

export type ClubTheme = {
  name: string;
  /** The disc's fill, `#RRGGBB`, from `club.brand_disc`. */
  disc: string;
  /** The knockout, `#RRGGBB`, from `club.brand_mark`. */
  mark: string;
};

export const loadClubTheme = cache(async (): Promise<ClubTheme> => {
  await connection();
  const admin = supabaseAdmin();
  let read: ClubRead;
  try {
    read = await admin.from("club").select("name, brand_disc, brand_mark").limit(1).maybeSingle();
  } catch (e) {
    read = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
  }
  return themeFromRead(read, (report) => after(() => reportErrorLive(report)));
});
