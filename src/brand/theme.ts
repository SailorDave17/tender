/**
 * The colours the app is painted in, and where they come from (stories #28, #41, #153).
 *
 * THE DECISION THIS FILE RECORDED WAS REVERSED ON 2026-09-17. Until #41 it said: *"the icons
 * rendered from the mark keep their own blue disc, and the app chrome around them stays hull
 * green. That is a real disagreement and it is deliberate — the club themes the badge, not the
 * product."* The owner reversed that at #153's gate: the club's pair themes the PRODUCT, and hull
 * green — the mark set's default, `brand/README.md` has the value — is retired from `src/`. The
 * one copy of that literal left under `src/` is rung 1's in `src/board/post-view.ts`, which is
 * the ladder's vocabulary and merely coincided with the brand; the owner declined re-keying it,
 * and `test/manifest.test.ts` holds that to be the only survivor. The reason for the reversal:
 * for a single-club pilot a green address bar above a
 * blue badge reads as a mistake rather than as a boundary, and the distinction it protected — the
 * app's identity kept apart from the club's mark — costs more than it buys.
 *
 * SINCE #41 THE PAIR IS NOT A CONSTANT AT ALL. `--brand-disc`, `--brand-mark`, the viewport's
 * `themeColor` and the manifest's `theme_color` are read from the `club` row on every request by
 * `src/brand/club-theme.ts`, and the admin sets them on `/admin/theme` with the 3:1 rule enforced
 * at save by `set_club_theme()` (0028). So there is no `THEME_COLOUR` to import any more: a
 * constant that the manifest read while the layout read the database is exactly the two-copies
 * drift `test/manifest.test.ts` exists to refuse. What survives here:
 *
 *   - `HOOVER_SAILING_CLUB` — the pilot club's pair, sampled from the burgee (`brand/`), and the
 *     value README's owner-runbook seed writes into the club row. Consent for it is settled:
 *     #11 closed 2026-08-22, recorded in `docs/charter.md` § Forge checks. It is the value tests
 *     build fixtures from and the value `test/club-seed.test.ts` holds the README's SQL to. A page
 *     reads it only when the row CANNOT be read: since #198 a refused read paints this pair
 *     (`DEFAULT_CLUB_THEME` in `club-theme-read.ts`) rather than failing the page. It is never
 *     read in place of a row that answered.
 *   - `BACKGROUND_COLOUR` — `--paper`, the light-mode page background and therefore the splash
 *     screen behind the installed app's icon. Still a constant: it is not a club decision.
 *
 * `globals.css` cannot import these — it is CSS — so `test/manifest.test.ts` holds its `--paper`
 * equal to `BACKGROUND_COLOUR`, and holds the manifest's `theme_color` to the theme it is built
 * from rather than to a literal (cairn: `a-computable-claim-does-not-belong-in-prose`).
 *
 * SINCE #153 THE PRODUCT'S PALETTE IS THE TOKEN LAYER IN `globals.css`, and it is constants, not
 * the row: `--accent` is `HOOVER_SAILING_CLUB.disc` (held there by `test/tokens.test.ts`), with
 * `--ink`, `--surface`, `--line` and the rest chosen around it and proven against each other in
 * both schemes. The row still paints the badge and the brand bar through `--brand-disc` /
 * `--brand-mark`; the product's accent does not follow the row, because a pair an admin may save
 * at 3:1 cannot promise 4.5:1 to the text that sits on it. `globals.css`'s header says the rest.
 */

/** Sampled from the club burgee: blue field, yellow device. Contrast 4.13:1. */
export const HOOVER_SAILING_CLUB = { disc: "#395FAC", mark: "#FCCF0B" } as const;

/** `--paper`. The light-mode page background, and therefore the splash screen behind the icon. */
export const BACKGROUND_COLOUR = "#EDF0EA";
