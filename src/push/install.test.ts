import { describe, expect, it } from "vitest";
import { belowHalfInstalled, installSummary, type InstallRow } from "./install";

/**
 * ADR 007's kill condition, at its boundary (story #29 AC 6).
 *
 * The number this computes is what story #32 reads to decide whether the bet survives, so the
 * cases that matter are the ones nobody would hit by accident: an empty club, exactly half, and
 * one short of half. A proportion is easy to get right in the middle and easy to get wrong at
 * the edge, and the edge is the only place it is ever consulted.
 */

const rows = (...devices: number[]): InstallRow[] =>
  devices.map((d, i) => ({ id: `p${i}`, name: `Person ${i}`, devices: d }));

describe("installSummary", () => {
  it("counts PEOPLE with a device, not devices — two phones is still one crew installed", () => {
    expect(installSummary(rows(2, 0, 1, 0))).toEqual({ installed: 2, total: 4, percent: 50 });
  });

  it("reads 0 of 0 on a club nobody has joined, rather than NaN%", () => {
    // A fresh club renders this page before anyone signs in. `0/0` is the natural arithmetic and
    // it puts the string "NaN%" in front of the owner on day one.
    expect(installSummary([])).toEqual({ installed: 0, total: 0, percent: 0 });
  });

  it("rounds toward zero, so a cohort just under half never reads as half", () => {
    // 124 of 250 is 49.6%. Rounding to nearest would print 50 and read as the bet surviving.
    const r = installSummary(rows(...Array(124).fill(1), ...Array(126).fill(0)));
    expect(r).toEqual({ installed: 124, total: 250, percent: 49 });
  });

  it("a person with zero devices is counted in the total and not in the installed", () => {
    expect(installSummary(rows(0, 0, 0))).toEqual({ installed: 0, total: 3, percent: 0 });
    expect(installSummary(rows(1, 1, 1))).toEqual({ installed: 3, total: 3, percent: 100 });
  });
});

describe("belowHalfInstalled — the trigger, on the counts and never the percentage", () => {
  it("fires below half and NOT at exactly half — the ADR says 'fewer than half'", () => {
    expect(belowHalfInstalled(installSummary(rows(1, 0, 0, 0)))).toBe(true); // 1 of 4
    expect(belowHalfInstalled(installSummary(rows(1, 1, 0, 0)))).toBe(false); // 2 of 4 — exactly half
    expect(belowHalfInstalled(installSummary(rows(1, 1, 1, 0)))).toBe(false); // 3 of 4
  });

  it("handles an odd cohort, where 'half' is not a whole number of people", () => {
    expect(belowHalfInstalled(installSummary(rows(1, 0, 0)))).toBe(true); // 1 of 3 is below
    expect(belowHalfInstalled(installSummary(rows(1, 1, 0)))).toBe(false); // 2 of 3 is above
  });

  it("does not fire on an empty club — there is no cohort to have failed", () => {
    // Otherwise the bet reads as killed on the day the club is created, before anyone is invited.
    expect(belowHalfInstalled(installSummary([]))).toBe(false);
  });

  it("is not the rounded percentage: 49% and 50% of an odd cohort agree here and would not there", () => {
    // 124 of 250 rounds to 49 either way, but the trigger must read the counts. This is the case
    // that separates them: 125 of 250 is exactly half — percent 50, and the trigger must not fire.
    const half = installSummary(rows(...Array(125).fill(1), ...Array(125).fill(0)));
    expect(half.percent).toBe(50);
    expect(belowHalfInstalled(half)).toBe(false);
  });
});
