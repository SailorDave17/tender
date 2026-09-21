/**
 * The contrast rule the club theme is held to (story #41), ported from `brand/TenderMark.jsx`
 * — which sat outside `tsconfig` and was compiled and tested by nothing — so that one typed copy
 * exists and `src/brand/contrast.test.ts` proves it.
 *
 * The badge is a graphical object, not text, so the applicable bar is WCAG 1.4.11 non-text
 * contrast at 3:1 — not the 4.5:1 used for body copy. An earlier draft of the .jsx used 4.5 and
 * would have rejected Hoover Sailing Club's own burgee colours, which sit at 4.13. Below 3:1 the
 * interior detail genuinely stops resolving and the badge reads as a solid blob at icon sizes.
 *
 * THE SAME RULE IS SPELLED A SECOND TIME IN SQL: `contrast_ratio()` and `set_club_theme()` in
 * `supabase/migrations/0028_club_theme.sql`, so the pair is refused at save whatever the screen
 * showed — a direct POST to the Server Action with a 1.5:1 pair is answered by the database, not
 * by this file. `test/club-theme.test.ts` holds the two spellings equal on the same pairs, which
 * is the #37 arrangement (`on_race_day` in SQL beside `localDate` in TypeScript): two readings of
 * one rule, each proven where it is written.
 */

/** `#RGB` or `#RRGGBB` — what the ratio accepts, as the .jsx did. */
const ANY_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `#RRGGBB` only — 0001's check constraint on `club.brand_disc` / `brand_mark`, so what this
 * accepts is exactly what the row accepts. The Server Action refuses anything else before it
 * reaches the database, and the SQL `contrast_ratio()` refuses it again with `'colour'`.
 */
const CLUB_HEX = /^#[0-9A-Fa-f]{6}$/;

export function isHexColour(value: string): boolean {
  return CLUB_HEX.test(value);
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). Throws on a non-colour rather than NaN. */
export function relativeLuminance(hex: string): number {
  if (!ANY_HEX.test(hex)) throw new Error(`${hex} is not a hex colour`);
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Contrast ratio between two hex colours, 1 (identical) to 21 (black/white). Symmetric. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hard reject — unusable below this. `set_club_theme()` raises `'contrast'` at the same line. */
export const MIN_CONTRAST = 3.0;
/** Comfortable; between this and MIN_CONTRAST, advise but allow (Hoover's own pair is 4.13). */
export const GOOD_CONTRAST = 4.5;

/** The comparison itself, so the boundary is testable at exactly 3.0 without needing a pair there. */
export function meetsMinimum(ratio: number): boolean {
  return ratio >= MIN_CONTRAST;
}

export function isValidTheme(disc: string, mark: string): boolean {
  return meetsMinimum(contrastRatio(disc, mark));
}

/** The two inks `inkOn` chooses between. Pure white and pure black on purpose — see below. */
export const INK_ON_LIGHT = "#000000";
export const INK_ON_DARK = "#FFFFFF";

/**
 * The ink for TEXT on a fill nobody has chosen yet — the club's disc, which an admin may set to
 * any colour that clears 3:1 against its mark (0028). 3:1 is the badge's bar, not text's, and no
 * constant can promise 4.5:1 against a colour that does not exist yet. What can: white or black,
 * whichever reads better. Their two ratios against any colour MULTIPLY to 21 — (1.05 / (L + 0.05))
 * × ((L + 0.05) / 0.05) — so the larger is always at least √21 ≈ 4.58, and 4.58 > 4.5. That is why
 * these are pure white and pure black and not the token layer's inks: `#1A1A1A` would make the
 * product 17.4 and the floor 4.17, which fails the text bar for a mid-tone disc.
 *
 * The root layout sets this on `<html>` as `--bar-ink` beside the pair (story #154; the defect was
 * found by #155's rendered-surface sweep, which read the Hoover pair itself at 4.13:1 under the
 * header's text). `contrast.test.ts` proves the floor over every colour of the 12-bit space.
 */
export function inkOn(fill: string): string {
  return contrastRatio(INK_ON_DARK, fill) >= contrastRatio(INK_ON_LIGHT, fill) ? INK_ON_DARK : INK_ON_LIGHT;
}
