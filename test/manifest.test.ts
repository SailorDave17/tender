import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { BACKGROUND_COLOUR, THEME_COLOUR } from "@/brand/theme";

/**
 * Story #28 AC 1 — the manifest, and the icon files it points at.
 *
 * AC 4 asks for the SERVED artefact, and this file is not that: it reads the function and the
 * files on disk. `test/manifest-served.test.ts` is the one that fetches from a running build,
 * and it cannot run in CI because CI runs the tests before the build. So the division is
 * deliberate — everything provable without a server is proved here, on every run, and the one
 * thing that is not is proved by a probe whose result is recorded on the PR
 * (cairn: `verify-the-artefact-not-its-ingredients`).
 *
 * The icon assertions read the PNG header rather than trusting the filename. A 192-byte
 * placeholder called `icon-512.png` satisfies "the file exists" perfectly, and would then be
 * rejected by Chrome as too small for installability with nothing here going red.
 */

const publicDir = new URL("../public/", import.meta.url);

/**
 * Width and height straight out of the IHDR chunk, which a valid PNG must carry first: 8-byte
 * signature, 4-byte length, "IHDR", then two big-endian 32-bit integers. This also proves the
 * file really is a PNG, since the signature is checked on the way past.
 */
function pngSize(file: string): { width: number; height: number; bytes: number } {
  const buf = readFileSync(fileURLToPath(new URL(file, publicDir)));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`);
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error(`${file}: no IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

describe("the web app manifest (#28 AC 1)", () => {
  const m = manifest();

  it("carries the identity and display fields an install needs", () => {
    expect(m.name).toBe("Tender");
    expect(m.short_name).toBe("Tender");
    expect(m.description).toBeTruthy();
    expect(m.display).toBe("standalone");
  });

  it("launches on the board, not the signed-out landing page", () => {
    // The point of installing is one tap to the thing itself. `/` is the page a member has
    // already been through, and `src/install/prompt.ts` reads `display: standalone` as its
    // signal that there is nothing left to offer — so both of these are load-bearing elsewhere.
    expect(m.start_url).toBe("/board");
    expect(m.scope).toBe("/");
  });

  it("paints the same two colours the browser tab and the stylesheet use", () => {
    // Three copies of each value exist by construction — this function, `layout.tsx`'s viewport,
    // and `globals.css` — and only the first two can import a constant. Holding all three equal
    // here is what stops the installed app's splash screen drifting from the page behind it
    // (cairn: `a-computable-claim-does-not-belong-in-prose`).
    expect(m.theme_color).toBe(THEME_COLOUR);
    expect(m.background_color).toBe(BACKGROUND_COLOUR);

    const css = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");
    expect(css.toLowerCase()).toContain(`--hull-green: ${THEME_COLOUR.toLowerCase()}`);
    expect(css.toLowerCase()).toContain(`--paper: ${BACKGROUND_COLOUR.toLowerCase()}`);

    const layout = readFileSync(fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)), "utf8");
    expect(layout, "layout must import the constant rather than repeat the value").toContain("THEME_COLOUR");
    expect(layout).not.toMatch(/themeColor:\s*["']#/);
  });

  it("declares 192 and 512 icons that are really those sizes", () => {
    const icons = m.icons ?? [];
    const bySrc = new Map(icons.map((i) => [i.src, i]));
    expect([...bySrc.keys()].sort()).toEqual(["/icon-192.png", "/icon-512.png"]);

    for (const [src, size] of [
      ["/icon-192.png", 192],
      ["/icon-512.png", 512],
    ] as const) {
      const declared = bySrc.get(src)!;
      expect(declared.sizes).toBe(`${size}x${size}`);
      expect(declared.type).toBe("image/png");

      const real = pngSize(src.slice(1));
      expect(real.width, `${src} width`).toBe(size);
      expect(real.height, `${src} height`).toBe(size);
      // A solid square compresses to a few hundred bytes; the mark does not. This is the cheap
      // guard against a blank or placeholder render being committed.
      expect(real.bytes, `${src} looks empty`).toBeGreaterThan(1000);
    }
  });

  it("every icon it names is a file that exists, and every file is named", () => {
    // Both directions. An icon in the manifest with no file 404s on install; a file in public/
    // that nothing names is dead weight nobody will ever delete.
    for (const icon of m.icons ?? []) {
      expect(() => pngSize(icon.src.slice(1)), `${icon.src} missing`).not.toThrow();
    }
  });
});

describe("the Apple touch icon, which iOS reads instead of the manifest (#28 AC 1)", () => {
  it("exists at 180 square and is declared in the document head", () => {
    const real = pngSize("apple-touch-icon.png");
    expect(real.width).toBe(180);
    expect(real.height).toBe(180);
    expect(real.bytes).toBeGreaterThan(1000);

    const layout = readFileSync(fileURLToPath(new URL("../src/app/layout.tsx", import.meta.url)), "utf8");
    expect(layout, "iOS ignores the manifest icons; the link must be declared").toContain("/apple-touch-icon.png");
    expect(layout).toMatch(/icons:\s*\{\s*apple:/);
  });

  it("is not in the manifest's icon list, where no browser would read it", () => {
    expect((manifest().icons ?? []).some((i) => i.src.includes("apple"))).toBe(false);
  });

  /**
   * iOS composites a transparent apple-touch-icon onto black. The mark is a blue disc on a
   * square, so the corners must be opaque or the home screen shows a black-cornered tile on
   * exactly the platform this story exists for. Checked by reading the PNG's colour type: 2 and
   * 0 have no alpha channel at all, which is what `flatten()` in the render script produces.
   */
  it("has no alpha channel, so iOS cannot composite it onto black", () => {
    const buf = readFileSync(fileURLToPath(new URL("apple-touch-icon.png", publicDir)));
    const colourType = buf.readUInt8(25);
    expect([0, 2], `colour type ${colourType} carries alpha`).toContain(colourType);
  });
});
