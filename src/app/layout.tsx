import type { CSSProperties, ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { loadClubTheme } from "@/brand/club-theme";
import { TenderMark } from "@/brand/TenderMark";
import { BuildStamp } from "@/build/BuildStamp";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tender",
  description: "The board that says who still needs a crew for Sunday.",
  // iOS reads this link for the home-screen icon and ignores the manifest's `icons` entirely, so
  // the installed app on the platform ADR 007's bet depends on gets its icon from here or from
  // nowhere (story #28). Declared rather than left to Safari's undeclared probe of
  // `/apple-touch-icon.png`: the fallback works today and is not a contract, and the failure —
  // a grey screenshot of the page on the home screen — is silent.
  icons: { apple: "/apple-touch-icon.png" },
};

/**
 * The browser tab's colour is the club's disc, from the same read the manifest's `theme_color`
 * comes from (story #41 AC 3) — so the tab and the installed app cannot end up painting two
 * different colours. `generateViewport` rather than a `viewport` object because the value is
 * read per request; `loadClubTheme` is `cache()`d, so the layout below does not read it twice.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await loadClubTheme();
  return {
    width: "device-width",
    initialScale: 1,
    themeColor: theme.disc,
  };
}

/**
 * The root layout. Since #41 it wears the club's colours: `--brand-disc` and `--brand-mark` are
 * set on `<html>` from the club row, `globals.css` paints from them, and the mark is rendered
 * INLINE as a component — never `<img src>`, which would be a separate document blind to the
 * page's colours (`src/brand/TenderMark.tsx`'s header).
 *
 * The brand bar is the least shell that puts the mark on a screen. #154 replaces it with the app
 * shell proper (navigation, skip link, identity, sign-out); until then it is one line so that
 * nothing here pre-decides what that story is for.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await loadClubTheme();
  const vars = { "--brand-disc": theme.disc, "--brand-mark": theme.mark } as CSSProperties;
  return (
    <html lang="en" style={vars}>
      <body>
        <header data-brand-bar>
          <TenderMark size={36} disc={theme.disc} mark={theme.mark} title={theme.name} />
          <span>Tender</span>
        </header>
        {children}
        <BuildStamp />
      </body>
    </html>
  );
}
