import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/brand/contrast";
import { BACKGROUND_COLOUR, HOOVER_SAILING_CLUB } from "@/brand/theme";
import { BAR, PAIRINGS, isColourToken, readTokenLayer, type Scheme } from "./tokens";

/**
 * Story #153 — the token layer, proven where it is written.
 *
 * AC 2: colour, type and space are custom properties on `:root`, and `--paper` survives.
 * AC 4: every colour token has a dark value of its own — not absent, not the light value again.
 * AC 5: every pairing in `PAIRINGS` clears its bar in BOTH schemes, with the ratio COMPUTED here
 *       by `src/brand/contrast.ts` (the #41 port) and never written down as a number in prose.
 *       The ratio is printed on pass as well as on fail, because a verdict alone cannot show a
 *       value drifting toward the line inside the passing band (cairn:
 *       `a-lint-preset-can-omit-the-rule-a-criterion-names`, the second instance).
 * AC 1, as #41 narrowed it: there is no `THEME_COLOUR` any more — the club row holds the pair
 *       (`theme.ts`'s header) — so what the product's palette is held to is the constant that
 *       DOES exist: `--accent` is `HOOVER_SAILING_CLUB.disc` and `--paper` is `BACKGROUND_COLOUR`.
 *
 * jsdom is not the instrument for any of this: it applies no stylesheet and evaluates no media
 * query, so a rendered component would read the same with the dark block deleted. The file is
 * read as text by `test/tokens.ts`, the same way `test/manifest.test.ts` reads `--paper`.
 */

const layer = readTokenLayer();
const SCHEMES: readonly Scheme[] = ["light", "dark"];

describe("the token layer declares colour, type and space on :root (#153 AC 2)", () => {
  it("carries every group, and --paper under that name", () => {
    const names = Object.keys(layer.light);
    // colour
    for (const t of ["--paper", "--surface", "--ink", "--ink-muted", "--line", "--accent", "--accent-ink"]) {
      expect(names, `${t} is a colour token`).toContain(t);
      expect(isColourToken(layer.light[t]), `${t} holds a colour`).toBe(true);
    }
    // type scale
    for (const t of ["--font-body", "--text-sm", "--text-md", "--text-lg", "--leading"]) {
      expect(names, `${t} is a type token`).toContain(t);
    }
    expect(layer.light["--text-sm"]).toMatch(/rem$/);
    // spacing scale, ascending
    const space = ["--space-1", "--space-2", "--space-3", "--space-4", "--space-6", "--space-8"];
    for (const t of space) expect(names, `${t} is a space token`).toContain(t);
    const rems = space.map((t) => parseFloat(layer.light[t]));
    expect(rems, "the spacing scale ascends").toEqual([...rems].sort((a, b) => a - b));
    expect(new Set(rems).size, "no two steps are the same size").toBe(rems.length);
  });

  it("holds the product palette to theme.ts: --accent is the Hoover disc, --paper is BACKGROUND_COLOUR (AC 1 as #41 narrowed it)", () => {
    expect(layer.light["--accent"].toLowerCase()).toBe(HOOVER_SAILING_CLUB.disc.toLowerCase());
    expect(layer.light["--paper"].toLowerCase()).toBe(BACKGROUND_COLOUR.toLowerCase());
  });

  it("never declares the club row's pair — those are set on <html> per request (#41)", () => {
    expect(Object.keys(layer.light)).not.toContain("--brand-disc");
    expect(Object.keys(layer.light)).not.toContain("--brand-mark");
    expect(Object.keys(layer.dark)).not.toContain("--brand-disc");
    expect(Object.keys(layer.dark)).not.toContain("--brand-mark");
  });
});

describe("every colour token has a dark value of its own (#153 AC 4)", () => {
  it("redeclares each light colour token under prefers-color-scheme: dark", () => {
    const missing = layer.colourNames.filter((name) => !(name in layer.dark));
    expect(missing, "colour tokens with no dark value (they would fall back to light)").toEqual([]);
  });

  it("gives each one a DIFFERENT value — a dark block that copies the light value is the fallback in disguise", () => {
    const same = layer.colourNames.filter((name) => layer.dark[name]?.toLowerCase() === layer.light[name].toLowerCase());
    expect(same, "colour tokens whose dark value repeats the light one").toEqual([]);
  });

  it("declares nothing in the dark block that the light block does not — a token born dark has no light value to fall back FROM", () => {
    const orphans = Object.keys(layer.dark).filter((name) => !(name in layer.light));
    expect(orphans).toEqual([]);
    // …and nothing but colours: a size that changes with the scheme would be a second scale.
    const nonColour = Object.keys(layer.dark).filter((name) => !isColourToken(layer.dark[name]));
    expect(nonColour, "non-colour tokens redeclared for dark").toEqual([]);
  });

  it("the colour tokens are the ones the pairings name (the proof covers the whole palette)", () => {
    const paired = new Set(PAIRINGS.flatMap((p) => [p.fg, p.bg]));
    const unpaired = layer.colourNames.filter((name) => !paired.has(name));
    expect(unpaired, "colour tokens no pairing holds to any bar").toEqual([]);
    const unknown = [...paired].filter((name) => !(name in layer.light));
    expect(unknown, "pairings naming a token that is not declared").toEqual([]);
  });
});

describe("every permitted pairing clears its bar in both schemes, computed (#153 AC 5)", () => {
  const cases = SCHEMES.flatMap((scheme) => PAIRINGS.map((p) => ({ scheme, ...p })));

  it.each(cases)("$scheme: $fg on $bg ≥ $bar ($use)", ({ scheme, fg, bg, bar }) => {
    const tokens = layer[scheme];
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    // Printed on pass too. A verdict cannot show a token creeping toward the line.
    console.log(`${scheme.padEnd(5)} ${fg.padEnd(14)} on ${bg.padEnd(14)} ${ratio.toFixed(2)}:1  (bar ${BAR[bar]})`);
    expect(ratio, `${scheme}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]}`).toBeGreaterThanOrEqual(BAR[bar]);
  });

  it("the bars are WCAG's, and the text bar is the stricter one", () => {
    expect(BAR.text).toBe(4.5);
    expect(BAR["non-text"]).toBe(3.0);
    expect(BAR.text).toBeGreaterThan(BAR["non-text"]);
  });

  it("the accent is a fill under --accent-ink, not the Hoover mark: the pair itself is below the text bar in light", () => {
    // 4.13:1 (`contrast.test.ts`), which is why the yellow is the club's mark on the badge and not
    // the product's text-on-accent colour — `--accent-ink` exists so the button label can read.
    const pair = contrastRatio(HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark);
    expect(pair).toBeLessThan(BAR.text);
    expect(contrastRatio(layer.light["--accent-ink"], layer.light["--accent"])).toBeGreaterThanOrEqual(BAR.text);
  });
});
