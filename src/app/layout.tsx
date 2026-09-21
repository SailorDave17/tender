import type { CSSProperties, ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { loadClubTheme } from "@/brand/club-theme";
import { inkOn } from "@/brand/contrast";
import { TenderMark } from "@/brand/TenderMark";
import { AppShell } from "@/shell/AppShell";
import { currentPerson } from "@/shell/session";
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
 * Since #154 every page renders inside `AppShell`: skip link, mark, product name, the signed-in
 * person and sign-out, navigation, the frame, the build stamp. The mark is built HERE, from the
 * row, and handed to the shell as an element, so this file stays the one that puts `theme.disc`
 * into `<TenderMark>` — `test/manifest.test.ts` reads it to prove tab, manifest and mark are one
 * read. The person is read once per request (`currentPerson` is `cache()`d) and is null on the
 * signed-out pages, where the shell shows a way in instead of a way out.
 *
 * `--bar-ink` is the TEXT colour on the brand bar, computed from the disc: white or black,
 * whichever reads better, which always clears 4.5:1 (`inkOn`). The mark colour is the badge's and
 * the focus ring's — a 3:1 non-text pair by 0028 — and #155's sweep read it at 4.13:1 as text.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [theme, person] = await Promise.all([loadClubTheme(), currentPerson()]);
  const vars = { "--brand-disc": theme.disc, "--brand-mark": theme.mark, "--bar-ink": inkOn(theme.disc) } as CSSProperties;
  return (
    <html lang="en" style={vars}>
      <body>
        <AppShell mark={<TenderMark size={36} disc={theme.disc} mark={theme.mark} title={theme.name} />} person={person}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
