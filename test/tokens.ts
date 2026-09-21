import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads the token layer out of `src/app/globals.css` as TEXT, the way `test/manifest.test.ts`
 * already reads `--paper` — because jsdom applies no stylesheet and evaluates no media query, so a
 * component test would pass with the dark block deleted and every pair pointed at itself. The
 * stylesheet is the artefact; this reads it where it is written (story #153).
 *
 * Two blocks are read, by their selectors: the light `:root { … }` and the `:root { … }` inside
 * `@media (prefers-color-scheme: dark)`. Nothing here parses CSS in general — a token is a
 * `--name: value;` line and a block is the braces after its selector — which is exactly enough
 * for a file this repo writes and holds to this shape, and refuses the moment it does not.
 *
 * `PAIRINGS` is the contract the tokens make with the surfaces: which foreground may sit on
 * which background, and at which bar. A surface that needs a pair not here adds it to this
 * table — which adds it to the proof in `tokens.test.ts` — never to the page alone. #155 extends
 * the table with the rendered surfaces' own pairs.
 */

export const GLOBALS_CSS = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));

export type Tokens = Record<string, string>;

/** `#rrggbb` only, lower or upper case — the shape `contrastRatio` takes and the file writes. */
const HEX = /^#[0-9a-f]{6}$/i;

export function isColourToken(value: string): boolean {
  return HEX.test(value.trim());
}

/** The `--name: value;` declarations inside one `{ … }` body. */
function declarations(body: string): Tokens {
  const out: Tokens = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const m of body.matchAll(re)) out[m[1]] = m[2].trim();
  return out;
}

/**
 * The body of the first `:root { … }` at or after `from`, and where it ends. Throws rather than
 * returning `{}` when there is none: an absent block reads exactly like an empty one, and a
 * missing dark block is the defect AC 4 exists to refuse.
 */
function rootBlock(css: string, from: number, what: string): { body: string; end: number } {
  const open = css.indexOf(":root", from);
  if (open < 0) throw new Error(`${what}: no :root block found in globals.css`);
  const brace = css.indexOf("{", open);
  const close = css.indexOf("}", brace);
  if (brace < 0 || close < 0) throw new Error(`${what}: :root block is not closed`);
  return { body: css.slice(brace + 1, close), end: close + 1 };
}

export type TokenLayer = {
  /** Every token declared on the light `:root`. */
  light: Tokens;
  /** Every token redeclared on `:root` inside the dark media query. */
  dark: Tokens;
  /** The light tokens whose value is a colour. */
  colourNames: string[];
};

export function readTokenLayer(css: string = readFileSync(GLOBALS_CSS, "utf8")): TokenLayer {
  const lightBlock = rootBlock(css, 0, "light scheme");
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  if (darkAt < 0) throw new Error("no @media (prefers-color-scheme: dark) block in globals.css");
  const darkBlock = rootBlock(css, darkAt, "dark scheme");
  const light = declarations(lightBlock.body);
  const dark = declarations(darkBlock.body);
  const colourNames = Object.keys(light).filter((name) => isColourToken(light[name]));
  return { light, dark, colourNames };
}

/** The scheme a pairing is read in. */
export type Scheme = "light" | "dark";

/** WCAG 2.x: 1.4.3 for text, 1.4.11 for non-text (boundaries, fills against the page). */
export type Bar = "text" | "non-text";
export const BAR: Record<Bar, number> = { text: 4.5, "non-text": 3.0 };

export type Pairing = {
  /** The token in front: text, or the boundary/fill being distinguished. */
  fg: string;
  /** The token behind it. */
  bg: string;
  bar: Bar;
  /** Where a surface uses it — so a pair nobody uses can be seen and removed. */
  use: string;
};

/**
 * Every pairing a surface may use, held in BOTH schemes. Read `use` before adding one: a pair
 * with no surface behind it is a promise nobody collects on, and a pair missing from here is a
 * surface painting outside the proof.
 */
export const PAIRINGS: readonly Pairing[] = [
  // text on the page and its surfaces
  { fg: "--ink", bg: "--paper", bar: "text", use: "body text on the page" },
  { fg: "--ink", bg: "--surface", bar: "text", use: "body text on a card or table cell" },
  { fg: "--ink", bg: "--accent-soft", bar: "text", use: "the member's own message, a highlighted row" },
  { fg: "--ink-muted", bg: "--paper", bar: "text", use: "a timestamp, a hint, the build stamp" },
  { fg: "--ink-muted", bg: "--surface", bar: "text", use: "a timestamp inside a card" },
  { fg: "--ink-muted", bg: "--accent-soft", bar: "text", use: "the time on the member's own message" },
  { fg: "--accent", bg: "--paper", bar: "text", use: "a link on the page" },
  { fg: "--accent", bg: "--surface", bar: "text", use: "a link inside a card" },
  { fg: "--accent", bg: "--accent-soft", bar: "text", use: "a link inside a highlighted row" },
  { fg: "--accent-ink", bg: "--accent", bar: "text", use: "the label on a primary button" },
  { fg: "--danger", bg: "--paper", bar: "text", use: "an error line on the page" },
  { fg: "--danger", bg: "--surface", bar: "text", use: "an error line inside a card" },
  { fg: "--danger", bg: "--danger-soft", bar: "text", use: "an error line on its own field" },
  { fg: "--warn", bg: "--paper", bar: "text", use: "the amber email-usage figure" },
  { fg: "--warn", bg: "--surface", bar: "text", use: "an amber figure inside a card" },
  { fg: "--ok", bg: "--paper", bar: "text", use: "a confirmation on the page" },
  { fg: "--ok", bg: "--surface", bar: "text", use: "a confirmation inside a card" },
  // boundaries and fills, which only need to be told apart from what they sit on
  { fg: "--line", bg: "--paper", bar: "non-text", use: "an input's border, a table rule on the page" },
  { fg: "--line", bg: "--surface", bar: "non-text", use: "a table rule inside a card" },
  { fg: "--accent", bg: "--paper", bar: "non-text", use: "a primary button's fill against the page" },
  { fg: "--accent", bg: "--surface", bar: "non-text", use: "a primary button's fill inside a card" },
  { fg: "--danger", bg: "--paper", bar: "non-text", use: "the left rule on an unsupported import row" },
  // the focus ring (#154): `outline-offset: 2px` puts the page around it on both sides, so the
  // adjacent colour is the surface it sits on, never the control's own fill. On the brand bar the
  // ring is `--brand-mark`, whose 3:1 against the disc is the database's promise (0028).
  { fg: "--focus", bg: "--paper", bar: "non-text", use: "a focused control on the page" },
  { fg: "--focus", bg: "--surface", bar: "non-text", use: "a focused control inside a card" },
  { fg: "--focus", bg: "--accent-soft", bar: "non-text", use: "a focused link in a highlighted row" },
  // NOT a pairing: `--surface` against `--paper`. A card's edge is one step off the page by design
  // (about 1.2:1 in light), and WCAG 1.4.11 binds a boundary only where it is the sole thing that
  // identifies a control — that boundary is `--line`, which is held above. A card that must be
  // told apart from the page draws `--line`, never relies on its fill.
];
