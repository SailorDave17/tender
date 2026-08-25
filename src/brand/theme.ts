/**
 * The two colours the browser chrome is told about, in one place (story #28).
 *
 * They are stated twice by construction — `viewport.themeColor` in `src/app/layout.tsx` colours
 * the address bar of a browser tab, and `theme_color` / `background_color` in
 * `src/app/manifest.ts` colour the splash screen and title bar of the installed app — and the two
 * surfaces are read by different code at different times, so nothing would ever complain if they
 * disagreed. A person would just see one green while the tab is open and another the moment they
 * launch it from the home screen. Importing both from here is what makes that impossible rather
 * than unlikely (cairn: `a-computable-claim-does-not-belong-in-prose`).
 *
 * The values are `globals.css`'s `--hull-green` and `--paper`. That file cannot import these —
 * it is CSS — so `test/manifest.test.ts` holds the three copies equal instead.
 *
 * These are NOT the mark's colours. `brand/hsc-mark-primary.svg` is the Hoover-themed pair
 * (`#395FAC` / `#FCCF0B`), which the README already records; the icons rendered from it keep
 * their own blue disc, and the app chrome around them stays hull green. That is a real
 * disagreement and it is deliberate — the club themes the badge, not the product.
 */

/** `--hull-green`. The app's primary, and the colour the browser paints its chrome. */
export const THEME_COLOUR = "#1E5443";

/** `--paper`. The light-mode page background, and therefore the splash screen behind the icon. */
export const BACKGROUND_COLOUR = "#EDF0EA";
