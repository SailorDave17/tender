import type { ErrorReport } from "@/notify/error";
import type { ClubTheme } from "./club-theme";
import { HOOVER_SAILING_CLUB } from "./theme";

/**
 * What a read of the club row MEANS for the page (story #198) — the pure half of
 * `src/brand/club-theme.ts`, which imports `server-only` and so cannot be imported by a test.
 *
 * WHY A FAILED READ NO LONGER FAILS THE PAGE. The root layout awaits the theme for every page, so
 * until #198 a single refused read of `club` was a failed page. On 2026-09-22 at 00:56:09Z the
 * platform refused one service-role read with `JWT issued at future` (1 of 477 service-key
 * requests that day; the next load 14 s later worked), and the owner, installing the app on their
 * phone, got the error screen instead of the board. The colours are the least important thing on
 * any page, so a refusal paints the DEFAULT theme and the page renders. Owner decision at pickup,
 * over a retry: no added latency and one path to prove.
 *
 * WHY IT IS STILL REPORTED. A fallback that works hides the failure it absorbs (cairn:
 * a-fallback-absorbs-the-symptom-its-diagnostic-names). Nothing throws any more, so Next's error
 * hook never sees this, and the report has to be made here. The loader hands it to the reporter
 * after the response (`after()`), so the member does not wait on the email.
 *
 * WHAT STILL THROWS. A MISSING row, with the runbook step in the message, exactly as before: that
 * is configuration, not a transient refusal, and a page painted in a colour nobody chose would
 * hide it. A missing service key still throws too, in `supabaseAdmin()`, before any read
 * (`scripts/server-env.mjs` classes it `throws`, #65).
 */

/**
 * The theme a page is painted in when the row cannot be read: the pilot club's own pair, which is
 * also what README's owner runbook seeds into the row. So for the one club that exists the page
 * looks exactly as it would have, unless an admin has saved a different pair on `/admin/theme` —
 * then that request shows the seed pair, which is the whole cost.
 */
export const DEFAULT_CLUB_THEME: ClubTheme = { name: "Hoover Sailing Club", ...HOOVER_SAILING_CLUB };

/** The error name a failed read is reported under, and so half of its dedupe signature. */
export const CLUB_THEME_READ_ERROR = "ClubThemeReadError";

/**
 * Where the report says it happened. The loader is not a route and has no request path of its own
 * (it runs for every page and for the manifest), so the signature keys on the loader's name. One
 * outage is then one error however many pages it touches, rather than one per route.
 */
export const CLUB_THEME_ROUTE = "loadClubTheme";

/** What PostgREST's `maybeSingle()` answers, narrowed to what this file reads. */
export type ClubRead = {
  data: { name: string; brand_disc: string; brand_mark: string } | null;
  error: { message: string } | null;
};

/** The report for a refused read, in the shape the error hook's reporter already takes. */
export function clubThemeFailureReport(message: string): ErrorReport {
  return {
    name: CLUB_THEME_READ_ERROR,
    message:
      `club theme could not be read: ${message}. ` +
      `The page was painted in the default theme (${DEFAULT_CLUB_THEME.disc} / ${DEFAULT_CLUB_THEME.mark}) instead of failing.`,
    stack: null,
    method: "GET",
    path: "(every page, and the manifest)",
    routePath: CLUB_THEME_ROUTE,
    routeType: "degraded",
    digest: null,
  };
}

/**
 * The theme a read yields. A refused read reports and falls back; a missing row throws; a row is
 * the theme. `report` is called at most once and before this returns.
 */
export function themeFromRead(read: ClubRead, report: (r: ErrorReport) => void): ClubTheme {
  if (read.error) {
    report(clubThemeFailureReport(read.error.message));
    return DEFAULT_CLUB_THEME;
  }
  if (!read.data) throw new Error("the club row is not seeded — README, owner runbook step 1");
  return { name: read.data.name, disc: read.data.brand_disc, mark: read.data.brand_mark };
}
