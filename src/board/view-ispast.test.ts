import { describe, expect, it, vi } from "vitest";

/**
 * Story #214 AC 4: the board's window decides "sailed" with `isPast` from the availability
 * rules, not with a second definition.
 *
 * view.test.ts reads the source for that, and a source reading can be passed by a respelling it
 * did not think of (`Date.parse(...) > now.valueOf()` passed its first version, found at review).
 * So here `isPast` is REPLACED with a rule no clock could produce: a date is past exactly when
 * its `starts_at` is the string "sailed". If the window follows that, it asks isPast. If it
 * compares times itself, in any spelling, it cannot.
 *
 * This file is separate because the replacement is module-wide, and view.test.ts needs the real
 * rule for its boundary cases.
 */

const asked: [string | Date, Date][] = [];
vi.mock("@/availability/rules", () => ({
  isPast: (startsAt: string | Date, now: Date) => {
    asked.push([startsAt, now]);
    return startsAt === "sailed";
  },
}));

const { showsDate, windowDates } = await import("./view");

// Real instants would order these the other way round: the "sailed" one is not a date at all,
// and the others are a century either side of `NOW`.
const NOW = new Date("2027-06-06T12:00:00.000Z");
const DATES = [
  { id: "long-ago", starts_at: "1927-06-06T12:00:00.000Z" },
  { id: "marked", starts_at: "sailed" },
  { id: "far-off", starts_at: "2127-06-06T12:00:00.000Z" },
];

describe("the board's window asks isPast, and only isPast (#214 AC 4)", () => {
  it("the default view hides exactly the date isPast calls past, whatever the clock would say", () => {
    asked.length = 0;
    const w = windowDates(DATES, NOW, "upcoming");
    expect(w.shown.map((d) => d.id)).toEqual(["long-ago", "far-off"]);
    expect(w.hidden).toBe(1);
    // Asked once per date, with the date's own `starts_at` and the caller's `now`.
    expect(asked).toEqual(DATES.map((d) => [d.starts_at, NOW]));
  });

  it("showsDate gives the same answer, since a redirect's row is decided by it", () => {
    expect(DATES.map((d) => showsDate("upcoming", d.starts_at, NOW))).toEqual([true, false, true]);
  });

  it("the full-season view lists every date and does not need to ask", () => {
    asked.length = 0;
    expect(windowDates(DATES, NOW, "season")).toEqual({ shown: DATES, hidden: 0 });
    expect(DATES.map((d) => showsDate("season", d.starts_at, NOW))).toEqual([true, true, true]);
    expect(asked).toEqual([]);
  });
});
