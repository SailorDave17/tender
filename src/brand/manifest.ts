import type { MetadataRoute } from "next";
import type { ClubTheme } from "./club-theme";
import { BACKGROUND_COLOUR } from "./theme";

/**
 * The web app manifest (story #28 AC 1), as a pure function of the club's theme (story #41 AC 3).
 * `src/app/manifest.ts` is the route Next serves at `/manifest.webmanifest`; it reads the club
 * row and calls this. Kept apart so `test/manifest.test.ts` can build the manifest from a theme
 * with no database and no request — the route file imports `server-only` through the loader and
 * cannot be imported by a test at all.
 *
 * This is the file that makes Tender installable, and installability is not cosmetic here: ADR
 * 007 bets the product on web push, and iOS delivers web push ONLY to a web app added to the
 * home screen (16.4+). So on the platform the fleet actually carries, no manifest means no
 * install means no push at all — a prerequisite for #29 rather than a polish pass.
 *
 * `start_url` is `/board`, not `/`. Launching from the home screen should land on the board,
 * which is the whole product; `/` is the signed-out landing page and someone who has installed
 * the app has already been through it. Anyone whose session has lapsed is sent to `/join` by the
 * proxy from there, which is the same route they would take anyway.
 *
 * `display: standalone` is what removes the browser chrome — and it is also the signal the
 * install banner reads to know it has nothing left to ask for (`src/install/prompt.ts` matches
 * `(display-mode: standalone)`), so changing it here silently changes when that banner appears.
 *
 * `theme_color` is the club's disc — the same value the layout's viewport paints the browser
 * tab, from the same read, so the tab and the installed app cannot show two different colours.
 * `background_color` stays `--paper`: the splash screen behind the icon is not a club decision.
 *
 * The icons are PNGs under `public/`, rendered from `brand/hsc-mark-primary.svg` by
 * `npm run icons`. They are committed rather than generated during the build so that what ships
 * is what was looked at; `test/manifest.test.ts` reads their real pixel dimensions back out of
 * the PNG header, so a placeholder or a wrongly-scaled export cannot pass. They are NOT themed
 * from the row — an icon is a file the OS copies at install time — so a club whose pair is not
 * the Hoover one gets a Hoover-blue icon until the PNGs are re-rendered. Said here rather than
 * left to be discovered.
 *
 * The Apple touch icon is deliberately NOT in this list. iOS ignores the manifest's icons for the
 * home screen and reads `<link rel="apple-touch-icon">` instead, which `src/app/layout.tsx`
 * declares against `/apple-touch-icon.png`. Listing it here would add a file no browser fetches
 * and leave the one that matters resting on Safari's undeclared root-probe fallback.
 */
export function manifestFor(theme: Pick<ClubTheme, "disc">): MetadataRoute.Manifest {
  return {
    name: "Tender",
    short_name: "Tender",
    description: "The board that says who still needs a crew for Sunday.",
    start_url: "/board",
    scope: "/",
    display: "standalone",
    theme_color: theme.disc,
    background_color: BACKGROUND_COLOUR,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
