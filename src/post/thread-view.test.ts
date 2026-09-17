import { describe, expect, it } from "vitest";
import {
  THREAD_CLOSED_NOTE,
  THREAD_OPEN_DAYS,
  explainMessageRefusal,
  threadClosesAt,
  threadIsOpen,
} from "./thread-view";

/**
 * AC 5 — the thread goes read-only seven days after the race. The clock is injected in every
 * case; a rule about elapsed days tested against the real clock is a rule tested once, on the
 * day it was written.
 */

const RACE = "2027-06-13T17:00:00Z";
const DAY = 24 * 60 * 60 * 1000;
const after = (days: number, ms = 0) => new Date(new Date(RACE).getTime() + days * DAY + ms);

describe("threadIsOpen — the seven-day window (AC 5)", () => {
  it("is open before the race and through the week after it", () => {
    expect(threadIsOpen(RACE, after(-3))).toBe(true);
    expect(threadIsOpen(RACE, after(0))).toBe(true); // the race start itself
    expect(threadIsOpen(RACE, after(1))).toBe(true);
    expect(threadIsOpen(RACE, after(6))).toBe(true);
  });

  it("straddles the boundary: open a second before, closed a second after", () => {
    expect(threadIsOpen(RACE, after(THREAD_OPEN_DAYS, -1000))).toBe(true);
    expect(threadIsOpen(RACE, after(THREAD_OPEN_DAYS, 1000))).toBe(false);
  });

  it("stays closed well afterwards", () => {
    expect(threadIsOpen(RACE, after(30))).toBe(false);
    expect(threadIsOpen(RACE, after(365))).toBe(false);
  });

  it("holds the window in a band whose edges are product statements, not the constant", () => {
    // The test that OWNS the value, so it names numbers rather than deriving them (cairn:
    // prove-a-guard-test-can-fail, fifteenth outcome — a test may derive its observation window
    // from the code under test, or test that window's value, but not both).
    //
    // Below about two days the thread shuts while the after-race conversation is still live
    // ("you left your gloves"); beyond about thirty it stops being a bounded arrangement between
    // two people and becomes an open channel to somebody's inbox, which is a different product.
    expect(THREAD_OPEN_DAYS).toBeGreaterThanOrEqual(2);
    expect(THREAD_OPEN_DAYS).toBeLessThanOrEqual(30);
  });

  it("closes exactly seven days after the start instant, not at a local midnight", () => {
    expect(threadClosesAt(RACE).toISOString()).toBe("2027-06-20T17:00:00.000Z");
    // A race that starts near midnight UTC closes at the same clock time seven days on — the
    // rule is elapsed time from an instant, so no zone arithmetic can shift it.
    expect(threadClosesAt("2027-06-13T23:30:00Z").toISOString()).toBe("2027-06-20T23:30:00.000Z");
  });

  it("is unaffected by a DST change between the race and the close", () => {
    // America/New_York leaves DST on 2027-11-07. A thread spanning it must still close after
    // exactly seven 24-hour days, because it is measured on instants.
    const beforeDst = "2027-11-04T18:00:00Z";
    expect(threadClosesAt(beforeDst).toISOString()).toBe("2027-11-11T18:00:00.000Z");
    expect(threadIsOpen(beforeDst, new Date("2027-11-11T17:59:00Z"))).toBe(true);
    expect(threadIsOpen(beforeDst, new Date("2027-11-11T18:01:00Z"))).toBe(false);
  });
});

describe("explainMessageRefusal", () => {
  it("names each refusal the action can hand back", () => {
    expect(explainMessageRefusal("too_long")).toContain("2,000");
    expect(explainMessageRefusal("empty")).toContain("Write something");
    expect(explainMessageRefusal("closed")).toBe(THREAD_CLOSED_NOTE);
    expect(explainMessageRefusal("refused")).toContain("two people matched");
  });

  it("falls back rather than showing a raw reason code", () => {
    expect(explainMessageRefusal("something_new")).toBe("That could not be sent.");
    expect(explainMessageRefusal("")).toBe("That could not be sent.");
  });
});
