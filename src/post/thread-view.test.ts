import { describe, expect, it } from "vitest";
import {
  MESSAGE_BODY_MAX,
  THREAD_CLOSED_NOTE,
  THREAD_OPEN_DAYS,
  explainMessageRefusal,
  sendMessageRefusal,
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

describe("sendMessageRefusal — every refusal the action decides itself (AC 2, AC 5)", () => {
  const open = { startsAt: RACE };
  const duringWeek = after(1);

  it("passes a good message in an open thread", () => {
    expect(sendMessageRefusal({ ...open, body: "D dock, 5pm." }, duringWeek)).toBeNull();
  });

  it("refuses an empty or whitespace-only body", () => {
    expect(sendMessageRefusal({ ...open, body: "" }, duringWeek)).toBe("empty");
    expect(sendMessageRefusal({ ...open, body: "   \n\t " }, duringWeek)).toBe("empty");
  });

  it("refuses a body over the cap, and accepts one exactly at it", () => {
    expect(sendMessageRefusal({ ...open, body: "x".repeat(MESSAGE_BODY_MAX + 1) }, duringWeek)).toBe("too_long");
    expect(sendMessageRefusal({ ...open, body: "x".repeat(MESSAGE_BODY_MAX) }, duringWeek)).toBeNull();
  });

  it("measures the cap AFTER trimming, so trailing whitespace cannot refuse a legal message", () => {
    const atCap = `${"x".repeat(MESSAGE_BODY_MAX)}   \n`;
    expect(atCap.length).toBeGreaterThan(MESSAGE_BODY_MAX);
    expect(sendMessageRefusal({ ...open, body: atCap }, duringWeek)).toBeNull();
  });

  // THE GUARD THE REVIEW FOUND UNTESTED. This is the seven-day close's only enforcement point —
  // RLS cannot express elapsed time and the page's ternary is render-time only — so if this
  // assertion goes, nothing anywhere stops a message being sent into a thread closed a year ago.
  it("refuses a message once the thread has closed, however good the body", () => {
    expect(sendMessageRefusal({ ...open, body: "D dock, 5pm." }, after(THREAD_OPEN_DAYS, 1000))).toBe("closed");
    expect(sendMessageRefusal({ ...open, body: "D dock, 5pm." }, after(365))).toBe("closed");
    // And still open a second before, so the refusal is the boundary and not a blanket no.
    expect(sendMessageRefusal({ ...open, body: "D dock, 5pm." }, after(THREAD_OPEN_DAYS, -1000))).toBeNull();
  });

  it("reports the body problem before the closed thread, so a person fixes what they typed first", () => {
    // Ordering is a product choice, not an accident: told 'the thread has closed' about a message
    // that was also too long, a person would fix nothing. Both are true; the actionable one wins.
    const closed = after(30);
    expect(sendMessageRefusal({ ...open, body: "" }, closed)).toBe("empty");
    expect(sendMessageRefusal({ ...open, body: "x".repeat(MESSAGE_BODY_MAX + 1) }, closed)).toBe("too_long");
    // But a GOOD body in the same closed thread must still be refused — without this line the
    // test passes with the closed check deleted entirely, since both cases above are decided
    // before it is reached. *Measured*: deleting the guard reddened 1 test against a predicted
    // 3, and this was one of the two that wrongly stayed green.
    expect(sendMessageRefusal({ ...open, body: "D dock, 5pm." }, closed)).toBe("closed");
  });

  it("every reason it returns has a sentence, with no gap between the two lists", () => {
    // A reason with no sentence falls through to the generic fallback, which is how a specific
    // refusal silently becomes "That could not be sent."
    for (const reason of ["empty", "too_long", "closed"] as const) {
      expect(explainMessageRefusal(reason)).not.toBe("That could not be sent.");
    }
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
