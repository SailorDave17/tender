import type { MetadataRoute } from "next";
import { BACKGROUND_COLOUR, THEME_COLOUR } from "@/brand/theme";

/**
 * The web app manifest (story #28 AC 1), served by Next at `/manifest.webmanifest`.
 *
 * This is the file that makes Tender installable, and installability is not cosmetic here: ADR
 * 007 bets the product on web push, and iOS delivers web push ONLY to a web app added to the
 * home screen (16.4+). So on the platform the fleet actually carries, no manifest means no
 * install means no push at all — this file is a prerequisite for #29 rather than a polish pass.
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
 * The icons are PNGs under `public/`, rendered from `brand/hsc-mark-primary.svg` by
 * `npm run icons`. They are committed rather than generated during the build so that what ships
 * is what was looked at; `test/manifest.test.ts` reads their real pixel dimensions back out of
 * the PNG header, so a placeholder or a wrongly-scaled export cannot pass.
 *
 * The Apple touch icon is deliberately NOT in this list. iOS ignores the manifest's icons for the
 * home screen and reads `<link rel="apple-touch-icon">` instead, which `src/app/layout.tsx`
 * declares against `/apple-touch-icon.png`. Listing it here would add a file no browser fetches
 * and leave the one that matters resting on Safari's undeclared root-probe fallback.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tender",
    short_name: "Tender",
    description: "The board that says who still needs a crew for Sunday.",
    start_url: "/board",
    scope: "/",
    display: "standalone",
    theme_color: THEME_COLOUR,
    background_color: BACKGROUND_COLOUR,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
