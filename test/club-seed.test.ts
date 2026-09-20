import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOOVER_SAILING_CLUB } from "../src/brand/theme";

/**
 * Story #41 AC 5 — README's owner-runbook seed for the club row carries the pair the club
 * accepted, and says that changing it afterwards is `/admin/theme` rather than an edit to the row.
 *
 * The SQL in the README is a copy of a value `src/brand/theme.ts` holds, which is the class that
 * drifts (cairn: a-computable-claim-does-not-belong-in-prose). The criterion as filed named the
 * mark set's default green; #11 closed the same day with the club's consent for the Hoover pair,
 * and the owner's comments on #41 say the seed carries that pair instead — so this holds the
 * README to the constant rather than to the criterion's original wording.
 */

const README = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");

describe("README's club-row seed (#41 AC 5)", () => {
  it("inserts the Hoover pair, in the seed statement and nowhere weaker", () => {
    const seeds = [...README.matchAll(/insert into public\.club \([^)]*\)\s*values \(([^)]*)\)/g)];
    expect(seeds.length, "the runbook carries exactly one seed statement").toBe(1);
    const values = seeds[0][1];
    expect(values).toContain(`'${HOOVER_SAILING_CLUB.disc}'`);
    expect(values).toContain(`'${HOOVER_SAILING_CLUB.mark}'`);
    // …and its columns are named, so the pair lands in the theme columns and not by position.
    expect(seeds[0][0]).toMatch(/insert into public\.club \(name, brand_disc, brand_mark, /);
  });

  it("says why it is that pair, and that the admin screen is where it changes afterwards", () => {
    // The consent record, so the next reader does not reach for the mark set's default green.
    expect(README).toMatch(/#11/);
    // The route that replaces a hand update once the story is in.
    const idx = README.indexOf("insert into public.club");
    const nearby = README.slice(idx, idx + 1500);
    expect(nearby).toContain("/admin/theme");
    expect(nearby).toMatch(/not an edit to this row/);
  });
});
