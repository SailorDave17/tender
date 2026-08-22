import { describe, expect, it } from "vitest";
import { availabilityRefusal, explainAvailabilityRefusal, isPast, summarise } from "./rules";

const now = new Date("2027-04-10T12:00:00Z");
const sunday = { starts_at: "2027-04-11T17:00:00Z" };
const lastSunday = { starts_at: "2027-04-04T17:00:00Z" };

describe("availabilityRefusal (AC 4, AC 5)", () => {
  it("a rated person may mark a future day", () => {
    expect(availabilityRefusal({ rating: 2 }, sunday, now)).toBeNull();
  });
  it("an unrated person is sent to their profile first, whatever the date", () => {
    expect(availabilityRefusal({ rating: null }, sunday, now)).toBe("no-rating");
    expect(availabilityRefusal({ rating: null }, lastSunday, now)).toBe("no-rating");
  });
  it("a past day is refused", () => {
    expect(availabilityRefusal({ rating: 2 }, lastSunday, now)).toBe("past");
  });
});

describe("isPast — the boundary is the start instant", () => {
  it("is false one ms before the start, true at it, true after", () => {
    const start = new Date("2027-04-11T17:00:00Z");
    expect(isPast(start, new Date(start.getTime() - 1))).toBe(false);
    expect(isPast(start, start)).toBe(true);
    expect(isPast(start.toISOString(), new Date(start.getTime() + 1))).toBe(true);
  });
});

describe("summarise — the count per day and whether it is mine", () => {
  it("counts every row for a day and flags the viewer's own", () => {
    const s = summarise(
      [
        { person_id: "ann", race_date_id: "d1" },
        { person_id: "bo", race_date_id: "d1" },
        { person_id: "bo", race_date_id: "d2" },
      ],
      "ann",
    );
    expect(s.get("d1")).toEqual({ count: 2, mine: true });
    expect(s.get("d2")).toEqual({ count: 1, mine: false });
    expect(s.get("d3")).toBeUndefined();
  });
});

describe("messages", () => {
  it("every refusal has its own message", () => {
    const reasons = ["no-rating", "past", "refused"];
    const messages = reasons.map(explainAvailabilityRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages).not.toContain(explainAvailabilityRefusal("else"));
  });
});
