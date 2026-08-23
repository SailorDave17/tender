import { describe, expect, it } from "vitest";
import { answerState, explainAnswerRefusal } from "./answer-rules";

/**
 * Story #20 AC 2 / AC 3 as a decision table with a fixed clock. The order of the rules matters
 * and is asserted: a closed post wins over everything, a started race over the viewer's own
 * state, an existing answer over availability (a crew who answered and then unmarked the day
 * still sees Withdraw, not a disabled I can).
 */

const startsAt = new Date("2027-04-11T17:00:00Z");
const before = new Date("2027-04-10T17:00:00Z");
const after = new Date("2027-04-11T17:00:01Z");
const open = { closed_at: null };
const closed = { closed_at: "2027-04-01T00:00:00Z" };
const date = { starts_at: startsAt.toISOString() };

describe("answerState", () => {
  it("available and not yet answered, post open, race ahead → can", () => {
    expect(answerState(open, date, { answered: false, available: true }, before)).toBe("can");
  });

  it("not available → unavailable (the disabled button with the link)", () => {
    expect(answerState(open, date, { answered: false, available: false }, before)).toBe("unavailable");
  });

  it("already answered → answered, whether or not still available", () => {
    expect(answerState(open, date, { answered: true, available: true }, before)).toBe("answered");
    expect(answerState(open, date, { answered: true, available: false }, before)).toBe("answered");
  });

  it("the race has started → past, even for an answerer", () => {
    expect(answerState(open, date, { answered: true, available: true }, after)).toBe("past");
    expect(answerState(open, date, { answered: false, available: true }, startsAt)).toBe("past");
  });

  it("the post is closed → closed, over every other state", () => {
    expect(answerState(closed, date, { answered: true, available: true }, before)).toBe("closed");
    expect(answerState(closed, date, { answered: false, available: false }, after)).toBe("closed");
  });
});

describe("explainAnswerRefusal", () => {
  it("names each refusal and falls back for an unknown one", () => {
    expect(explainAnswerRefusal("closed")).toMatch(/closed/);
    expect(explainAnswerRefusal("past")).toMatch(/already started/);
    expect(explainAnswerRefusal("not-available")).toMatch(/board first/);
    expect(explainAnswerRefusal("refused")).toMatch(/database refused/);
    expect(explainAnswerRefusal("??")).toBe("That could not be saved.");
  });
});
