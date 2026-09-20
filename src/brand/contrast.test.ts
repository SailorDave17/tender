import { describe, expect, it } from "vitest";
import {
  GOOD_CONTRAST,
  MIN_CONTRAST,
  contrastRatio,
  isHexColour,
  isValidTheme,
  meetsMinimum,
  relativeLuminance,
} from "./contrast";
import { HOOVER_SAILING_CLUB } from "./theme";

/**
 * Story #41 AC 1 — the port of `brand/TenderMark.jsx`'s contrast rule, proven where it now lives.
 *
 * The four values the criterion names are asserted as numbers this file computes, never copied
 * from prose. "A pair at exactly 3.0" is read two ways, because no #RRGGBB pair lands on 3.0 in
 * floating point: the comparison is tested at the literal boundary (`meetsMinimum(3.0)`), and
 * the two real pairs nearest the line — found by scanning every grey-on-grey pair — are tested
 * on either side of it, which is what proves the rule is `>=` rather than `>`.
 */

/** The nearest grey pairs to 3.0 on either side, from a scan of all 256x256 grey-on-grey pairs. */
const JUST_ABOVE = ["#242424", "#6D6D6D"] as const; // 3.0000043
const JUST_BELOW = ["#1B1B1B", "#666666"] as const; // 2.9998038

describe("contrastRatio (#41 AC 1)", () => {
  it("Hoover's pair reads 4.13 and passes", () => {
    const r = contrastRatio(HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark);
    expect(r).toBeCloseTo(4.13, 2);
    expect(isValidTheme(HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark)).toBe(true);
    // …and sits under the comfort line, which is why the hard threshold is 3.0 and not 4.5.
    expect(r).toBeLessThan(GOOD_CONTRAST);
  });

  it("a colour against itself reads 1.0 and fails", () => {
    expect(contrastRatio("#395FAC", "#395FAC")).toBe(1);
    expect(isValidTheme("#395FAC", "#395FAC")).toBe(false);
  });

  it("black on white reads 21", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 10);
    expect(isValidTheme("#000000", "#FFFFFF")).toBe(true);
  });

  it("a pair at exactly 3.0 passes — the rule is >=, and the nearest real pairs fall either side", () => {
    expect(MIN_CONTRAST).toBe(3.0);
    expect(meetsMinimum(3.0)).toBe(true);
    expect(meetsMinimum(3.0 - 1e-9)).toBe(false);

    const above = contrastRatio(...JUST_ABOVE);
    const below = contrastRatio(...JUST_BELOW);
    expect(above).toBeGreaterThanOrEqual(3.0);
    expect(above).toBeLessThan(3.001);
    expect(below).toBeLessThan(3.0);
    expect(below).toBeGreaterThan(2.999);
    expect(isValidTheme(...JUST_ABOVE)).toBe(true);
    expect(isValidTheme(...JUST_BELOW)).toBe(false);
  });

  it("is symmetric, so disc-on-mark and mark-on-disc are one answer", () => {
    expect(contrastRatio("#FCCF0B", "#395FAC")).toBe(contrastRatio("#395FAC", "#FCCF0B"));
  });

  it("takes #RGB shorthand as the .jsx did, and lower case", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 10);
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 10);
    expect(relativeLuminance("#000")).toBe(0);
  });

  it("refuses a non-colour rather than answering NaN", () => {
    // The .jsx returned NaN here, which `>= 3` reads as false — a refusal that names nothing.
    expect(() => contrastRatio("navy", "#FFFFFF")).toThrow(/navy is not a hex colour/);
    expect(() => relativeLuminance("#GGGGGG")).toThrow(/not a hex colour/);
  });
});

describe("isHexColour — the club row's own spelling (0001's check constraint)", () => {
  it("accepts #RRGGBB in either case and nothing else", () => {
    expect(isHexColour("#395FAC")).toBe(true);
    expect(isHexColour("#fccf0b")).toBe(true);
    expect(isHexColour("#FFF")).toBe(false); // the ratio takes it; the row does not
    expect(isHexColour("395FAC")).toBe(false);
    expect(isHexColour("#395FAC ")).toBe(false);
    expect(isHexColour("navy")).toBe(false);
  });
});
