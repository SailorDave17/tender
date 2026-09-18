import { describe, expect, it } from "vitest";
import {
  FAILURE_LINE,
  NO_READING,
  elapsedRaceDays,
  formatRatio,
  seasonMetric,
  type MetricMatch,
  type MetricRaceDate,
} from "./metric";

/**
 * Story #38 AC 3 — the season's metric, at its boundaries.
 *
 * The case that earns this file is the empty season: zero matches over zero race days is not
 * 0.00, and a division would make it NaN while a naive guard would make it a confident failure.
 * Both are tested here, in both directions.
 */

const NOW = new Date("2026-06-15T12:00:00Z");

function days(starts: readonly string[]): MetricRaceDate[] {
  return starts.map((s, i) => ({ id: `d${i}`, starts_at: s }));
}

function matches(n: number): MetricMatch[] {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, post_id: `p${i}` }));
}

describe("elapsedRaceDays", () => {
  it("counts a date whose start has passed and not one still to come", () => {
    const d = days(["2026-05-01T17:00:00Z", "2026-07-01T17:00:00Z"]);
    expect(elapsedRaceDays(d, NOW)).toBe(1);
  });

  it("counts a date starting exactly at now — the start instant belongs to the race", () => {
    expect(elapsedRaceDays(days([NOW.toISOString()]), NOW)).toBe(1);
  });

  it("does not count a date one second away", () => {
    const soon = new Date(NOW.getTime() + 1000).toISOString();
    expect(elapsedRaceDays(days([soon]), NOW)).toBe(0);
  });

  it("is zero for an empty season", () => {
    expect(elapsedRaceDays([], NOW)).toBe(0);
  });
});

describe("seasonMetric — AC 3's stated cases", () => {
  it("returns 0.70 for 10 elapsed days and 7 matches", () => {
    const d = days(Array.from({ length: 10 }, (_, i) => `2026-0${(i % 5) + 1}-0${(i % 9) + 1}T17:00:00Z`));
    const m = seasonMetric(matches(7), d, NOW);
    expect(m.raceDaysElapsed).toBe(10);
    expect(m.matches).toBe(7);
    expect(m.ratio).toBe(0.7);
    expect(formatRatio(m)).toBe("0.70");
  });

  it("returns no reading rather than dividing by zero when nothing has elapsed", () => {
    const m = seasonMetric(matches(0), days(["2026-09-01T17:00:00Z"]), NOW);
    expect(m.raceDaysElapsed).toBe(0);
    // The point of the whole file: null, not 0, and not NaN.
    expect(m.ratio).toBeNull();
    expect(Number.isNaN(m.ratio as unknown as number)).toBe(false);
    expect(formatRatio(m)).toBe(NO_READING);
  });

  it("does not call an unmeasured season a failure", () => {
    // A guard that returned 0 here would read as below the line and kill the charter's bet on
    // the day the club was created.
    const m = seasonMetric([], [], NOW);
    expect(m.belowLine).toBe(false);
    // `belowLine` alone does NOT guard this: mutate the zero-check away and 0/0 is NaN, and
    // `NaN < 1.0` is false — so the assertion above passes on a broken function for a reason
    // that has nothing to do with the claim. Measured on this story (M1, 2 red against a
    // predicted 4). The ratio is what carries the claim, so it is asserted here too.
    expect(m.ratio).toBeNull();
    expect(formatRatio(m)).toBe(NO_READING);
  });

  it("counts a match whose people are gone — the row is the event", () => {
    // AC 3: "an anonymised match still counts". The metric never dereferences a person, so this
    // is a claim about the type as much as the count: MetricMatch carries no person at all.
    const anonymised: MetricMatch[] = [{ id: "m1", post_id: "p1" }];
    const m = seasonMetric(anonymised, days(["2026-05-01T17:00:00Z"]), NOW);
    expect(m.matches).toBe(1);
    expect(m.ratio).toBe(1);
  });
});

describe("seasonMetric — the failure line", () => {
  it("is below the line strictly under 1.0, and not at it", () => {
    const two = days(["2026-05-01T17:00:00Z", "2026-05-08T17:00:00Z"]);
    expect(seasonMetric(matches(1), two, NOW).belowLine).toBe(true);
    expect(seasonMetric(matches(2), two, NOW).belowLine).toBe(false);
    expect(FAILURE_LINE).toBe(1.0);
  });

  it("reads the line off the UNROUNDED ratio, so 0.996 prints 1.00 and still fails", () => {
    // 249 matches over 250 days = 0.996 -> prints "1.00". A belowLine computed on the rounded
    // figure would report this season as meeting the charter's bar.
    const d = days(Array.from({ length: 250 }, (_, i) => `2026-01-01T0${i % 10}:00:00Z`));
    const m = seasonMetric(matches(249), d, NOW);
    expect(formatRatio(m)).toBe("1.00");
    expect(m.belowLine).toBe(true);
  });

  it("rounds to two decimals half-up", () => {
    // 2 matches / 3 days = 0.6666… -> 0.67
    const three = days(["2026-05-01T17:00:00Z", "2026-05-08T17:00:00Z", "2026-05-15T17:00:00Z"]);
    expect(formatRatio(seasonMetric(matches(2), three, NOW))).toBe("0.67");
  });

  it("counts only elapsed days, so publishing next season does not sink the figure", () => {
    const d = days([
      "2026-05-01T17:00:00Z",
      "2026-05-08T17:00:00Z",
      // Twenty dates entered for next year, none of them elapsed.
      ...Array.from({ length: 20 }, (_, i) => `2027-05-${String(i + 1).padStart(2, "0")}T17:00:00Z`),
    ]);
    const m = seasonMetric(matches(2), d, NOW);
    expect(m.raceDaysElapsed).toBe(2);
    expect(m.ratio).toBe(1);
  });
});
