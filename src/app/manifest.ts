import type { MetadataRoute } from "next";
import { loadClubTheme } from "@/brand/club-theme";
import { manifestFor } from "@/brand/manifest";

/**
 * `/manifest.webmanifest` (story #28 AC 1), built from the club row's theme (story #41 AC 3).
 *
 * The content and its reasons are in `src/brand/manifest.ts`; this file only reads the row.
 * The loader calls `connection()`, which is what keeps Next from caching this route at build —
 * a manifest cached at build time would carry whatever pair the row held then, and
 * `/admin/theme` would change the tab colour and never the installed app's.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  return manifestFor(await loadClubTheme());
}
