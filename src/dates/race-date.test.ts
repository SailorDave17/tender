import { describe, expect, it } from "vitest";
import {
  explainRefusal,
  formatStartsAt,
  localDate,
  parseRaceDateForm,
  zonedToUtc,
} from "./race-date";

// A Sunday in April 2027, 13:00 in Ohio (EDT, UTC-4) — the shape of every HSC race day.
const SUNDAY = { date: "2027-04-11", time: "13:00", title: "Spring series 1" };
// "Now" is the Friday before, mid-morning in Ohio.
const NOW = new Date("2027-04-09T14:00:00Z");

describe("parseRaceDateForm — what is refused, and that nothing is invented (AC 2)", () => {
  it("stores the club's local wall time as an instant", () => {
    const r = parseRaceDateForm(SUNDAY, NOW);
    expect(r).toEqual({ ok: true, startsAt: new Date("2027-04-11T17:00:00Z"), title: "Spring series 1" });
  });

  it.each([
    [{ ...SUNDAY, date: "" }, "blank-date"],
    [{ ...SUNDAY, date: "   " }, "blank-date"],
    [{ ...SUNDAY, date: "11/04/2027" }, "blank-date"],
    [{ ...SUNDAY, time: "" }, "blank-time"],
    [{ ...SUNDAY, time: "1pm" }, "blank-time"],
    [{ ...SUNDAY, time: "25:00" }, "blank-time"],
    [{ ...SUNDAY, time: "13:60" }, "blank-time"],
    [{ ...SUNDAY, title: "" }, "blank-title"],
    [{ ...SUNDAY, title: "  " }, "blank-title"],
    [{ ...SUNDAY, title: "x".repeat(81) }, "title-too-long"],
    [{ ...SUNDAY, date: "2027-02-30" }, "invalid-date"],
    [{ ...SUNDAY, date: "2027-13-01" }, "invalid-date"],
  ])("refuses %o as %s", (input, reason) => {
    expect(parseRaceDateForm(input, NOW)).toEqual({ ok: false, reason });
  });

  it("a blank time is refused before the title is looked at — no default start time exists", () => {
    expect(parseRaceDateForm({ date: "2027-04-11", time: "", title: "" }, NOW)).toEqual({
      ok: false,
      reason: "blank-time",
    });
  });

  it("trims the title and keeps one of exactly 80 characters", () => {
    const r = parseRaceDateForm({ ...SUNDAY, title: `  ${"y".repeat(80)}  ` }, NOW);
    expect(r.ok && r.title).toBe("y".repeat(80));
  });
});

describe("parseRaceDateForm — 'earlier than today' is decided on the club's calendar (AC 2)", () => {
  it("refuses yesterday and accepts today and tomorrow", () => {
    const now = new Date("2027-04-09T14:00:00Z"); // Fri 9 Apr, 10:00 EDT
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-08" }, now)).toEqual({
      ok: false,
      reason: "past-date",
    });
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-09" }, now).ok).toBe(true);
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-10" }, now).ok).toBe(true);
  });

  it("late evening in Ohio is still today there, even though UTC has rolled over", () => {
    const now = new Date("2027-04-12T03:30:00Z"); // Sun 11 Apr, 23:30 EDT
    expect(localDate(now)).toBe("2027-04-11");
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-11" }, now).ok).toBe(true);
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-10" }, now)).toEqual({
      ok: false,
      reason: "past-date",
    });
  });

  it("just after midnight in Ohio, yesterday's date is gone", () => {
    const now = new Date("2027-04-12T04:30:00Z"); // Mon 12 Apr, 00:30 EDT
    expect(localDate(now)).toBe("2027-04-12");
    expect(parseRaceDateForm({ ...SUNDAY, date: "2027-04-11" }, now)).toEqual({
      ok: false,
      reason: "past-date",
    });
  });
});

describe("zonedToUtc — America/New_York, both sides of the clock change", () => {
  it.each([
    ["2027-01-10", "13:00", "2027-01-10T18:00:00.000Z", "EST, UTC-5"],
    ["2027-04-11", "13:00", "2027-04-11T17:00:00.000Z", "EDT, UTC-4"],
    ["2027-03-14", "01:00", "2027-03-14T06:00:00.000Z", "spring-forward day, before 02:00"],
    ["2027-03-14", "05:00", "2027-03-14T09:00:00.000Z", "spring-forward day, just after — needs the second pass"],
    ["2027-03-14", "13:00", "2027-03-14T17:00:00.000Z", "spring-forward day, after 02:00"],
    ["2027-11-07", "00:30", "2027-11-07T04:30:00.000Z", "fall-back day, before 02:00"],
    ["2027-11-07", "03:00", "2027-11-07T08:00:00.000Z", "fall-back day, just after — needs the second pass"],
    ["2027-11-07", "13:00", "2027-11-07T18:00:00.000Z", "fall-back day, after 02:00"],
  ])("%s %s → %s (%s)", (date, time, iso) => {
    expect(zonedToUtc(date, time).toISOString()).toBe(iso);
  });
});

describe("formatStartsAt — the board reads local date and time (AC 3)", () => {
  it("renders an EDT instant on the club's clock", () => {
    const f = formatStartsAt("2027-04-11T17:00:00Z");
    expect(f.date).toBe("Sun, Apr 11, 2027");
    expect(f.time).toMatch(/^1:00\sPM$/);
  });

  it("renders an EST instant on the club's clock", () => {
    const f = formatStartsAt("2027-01-10T18:00:00Z");
    expect(f.date).toBe("Sun, Jan 10, 2027");
    expect(f.time).toMatch(/^1:00\sPM$/);
  });
});

describe("explainRefusal", () => {
  it("has a sentence for every refusal and a fallback", () => {
    for (const r of ["blank-date", "blank-time", "invalid-date", "past-date", "blank-title", "title-too-long", "refused"]) {
      expect(explainRefusal(r)).not.toBe(explainRefusal("something-else"));
    }
    expect(explainRefusal("blank-time")).toMatch(/no default/);
  });
});
