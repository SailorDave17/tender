#!/usr/bin/env node
/**
 * Render the home-screen icons from the brand mark (story #28 AC 1). `npm run icons`.
 *
 * The mark is `brand/hsc-mark-primary.svg`, one 128x128 artboard the whole set shares. The PNGs
 * it produces are COMMITTED, and this script exists to regenerate them rather than to run in the
 * build: what ships should be what somebody looked at, and a build-time render would put an
 * unreviewed image in front of every member on any day `sharp` changed its rasteriser.
 *
 * So `sharp` is a devDependency, and CI never runs this. `test/manifest.test.ts` is what holds
 * the committed output honest — it reads each PNG's real width and height back out of the file
 * header, so a stale, missing or wrongly-scaled icon reddens the suite even though nothing here
 * ran.
 *
 * Sizes, and why these three:
 *   - 192 and 512 are the manifest's pair. 192 is what Android puts on the home screen; 512 is
 *     what it uses for the splash screen, and the minimum Chrome accepts for installability.
 *   - 180 is `apple-touch-icon.png`. iOS reads the `<link rel="apple-touch-icon">` in the
 *     document head, never the manifest, so this one has nothing to do with the pair above; 180
 *     is the @3x home-screen size every smaller slot downsamples from cleanly.
 *
 * The background is painted rather than left transparent. iOS composites a transparent
 * apple-touch-icon onto BLACK, so the mark's yellow rigging on a blue disc would sit in a black
 * square on exactly the platform this story exists for.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "brand", "hsc-mark-primary.svg");
const outDir = join(repoRoot, "public");

/** `--paper`, the same value `src/brand/theme.ts` gives the manifest's `background_color`. */
const BACKGROUND = "#EDF0EA";

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

const svg = await readFile(source);
await mkdir(outDir, { recursive: true });

for (const { file, size } of targets) {
  const png = await sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain", background: BACKGROUND })
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const out = join(outDir, file);
  await writeFile(out, png);

  // Read the result back rather than reporting the request: a resize that silently produced
  // something else is exactly what the committed file would then carry.
  const meta = await sharp(png).metadata();
  if (meta.width !== size || meta.height !== size) {
    throw new Error(`${file}: asked for ${size}x${size}, got ${meta.width}x${meta.height}`);
  }
  console.log(`${file}  ${meta.width}x${meta.height}  ${png.length} bytes  sha256:${createHash("sha256").update(png).digest("hex").slice(0, 12)}`);
}
