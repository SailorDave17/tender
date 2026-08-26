import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { THEME_COLOUR } from "@/brand/theme";
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

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Same value as the manifest's `theme_color`, from one constant, so the browser tab and the
  // installed app cannot end up painting two different greens.
  themeColor: THEME_COLOUR,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
