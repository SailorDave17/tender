import { describe, expect, it } from "vitest";
import { contentLines, parseRaceIcs, planImport, readPublishRow, unescapeText } from "./ics-import";

/**
 * parseRaceIcs() (story #40, AC 1): the three DTSTART forms, both DST boundaries, an empty file,
 * a DTSTART reported by line rather than thrown, an RRULE flagged rather than expanded — then the
 * format rules a reader owes the file (folding, escaping, CRLF, nested components), and the
 * publish plan (AC 3's "no duplicates on re-import").
 *
 * 2027 in Ohio: clocks go forward on Sunday 14 March and back on Sunday 7 November. 1 pm EDT is
 * 17:00Z; 1 pm EST is 18:00Z.
 */

const CRLF = "\r\n";

/** A VCALENDAR wrapping the given VEVENT bodies (each an array of content lines). */
function calendar(...events: string[][]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN"];
  for (const ev of events) lines.push("BEGIN:VEVENT", ...ev, "END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

const UID = "UID:x@example.org";

describe("parseRaceIcs — the three DTSTART forms (AC 1)", () => {
  it("reads a UTC DTSTART as the instant written", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z", "SUMMARY:Spring series 1"]));
    expect(r).toEqual({
      rows: [{ startsAt: "2027-04-11T17:00:00.000Z", title: "Spring series 1", line: 4 }],
      problems: [],
    });
  });

  it("reads TZID=America/New_York as that wall clock", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART;TZID=America/New_York:20270411T130000", "SUMMARY:Spring series 1"]));
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-04-11T17:00:00.000Z"]);
    expect(r.problems).toEqual([]);
  });

  it("reads a floating DTSTART as America/New_York", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270411T130000", "SUMMARY:Spring series 1"]));
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-04-11T17:00:00.000Z"]);
    expect(r.problems).toEqual([]);
  });

  it("accepts a quoted TZID and one Intl knows that is not the club's", () => {
    const r = parseRaceIcs(
      calendar(
        [UID, 'DTSTART;TZID="America/New_York":20270411T130000', "SUMMARY:Quoted"],
        [UID, "DTSTART;TZID=Europe/London:20270411T180000", "SUMMARY:London"],
      ),
    );
    // 18:00 BST is 17:00Z — the same instant as 1 pm in Ohio that day.
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-04-11T17:00:00.000Z", "2027-04-11T17:00:00.000Z"]);
  });

  it("keeps the file's order, not date order", () => {
    const r = parseRaceIcs(
      calendar(
        [UID, "DTSTART:20270502T170000Z", "SUMMARY:Second in May"],
        [UID, "DTSTART:20270411T170000Z", "SUMMARY:First in April"],
      ),
    );
    expect(r.rows.map((x) => x.title)).toEqual(["Second in May", "First in April"]);
  });

  it("carries seconds through in both forms", () => {
    const r = parseRaceIcs(
      calendar([UID, "DTSTART:20270411T170030Z", "SUMMARY:a"], [UID, "DTSTART:20270411T130030", "SUMMARY:b"]),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-04-11T17:00:30.000Z", "2027-04-11T17:00:30.000Z"]);
  });
});

describe("parseRaceIcs — the DST boundaries (AC 1)", () => {
  it("March: the Saturday before the change is EST, the Sunday of it is EDT (floating)", () => {
    const r = parseRaceIcs(
      calendar([UID, "DTSTART:20270313T130000", "SUMMARY:Sat"], [UID, "DTSTART:20270314T130000", "SUMMARY:Sun"]),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-03-13T18:00:00.000Z", "2027-03-14T17:00:00.000Z"]);
  });

  it("March: the same two days with TZID", () => {
    const r = parseRaceIcs(
      calendar(
        [UID, "DTSTART;TZID=America/New_York:20270313T130000", "SUMMARY:Sat"],
        [UID, "DTSTART;TZID=America/New_York:20270314T130000", "SUMMARY:Sun"],
      ),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-03-13T18:00:00.000Z", "2027-03-14T17:00:00.000Z"]);
  });

  it("November: the Saturday before the change is EDT, the Sunday of it is EST (floating)", () => {
    const r = parseRaceIcs(
      calendar([UID, "DTSTART:20271106T130000", "SUMMARY:Sat"], [UID, "DTSTART:20271107T130000", "SUMMARY:Sun"]),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-11-06T17:00:00.000Z", "2027-11-07T18:00:00.000Z"]);
  });

  it("November: the same two days with TZID", () => {
    const r = parseRaceIcs(
      calendar(
        [UID, "DTSTART;TZID=America/New_York:20271106T130000", "SUMMARY:Sat"],
        [UID, "DTSTART;TZID=America/New_York:20271107T130000", "SUMMARY:Sun"],
      ),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-11-06T17:00:00.000Z", "2027-11-07T18:00:00.000Z"]);
  });

  it("the early hours of a change day resolve with the offset in force at that hour (floating)", () => {
    // 03:00 on 14 March is already EDT (07:00Z); 03:00 on 7 November is already EST (08:00Z).
    // Both need zonedToUtc's second pass: the offset read at the naive instant is the old one.
    const r = parseRaceIcs(
      calendar([UID, "DTSTART:20270314T030000", "SUMMARY:Mar"], [UID, "DTSTART:20271107T030000", "SUMMARY:Nov"]),
    );
    expect(r.rows.map((x) => x.startsAt)).toEqual(["2027-03-14T07:00:00.000Z", "2027-11-07T08:00:00.000Z"]);
  });

  it("a UTC DTSTART on the change day is untouched by the zone", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270314T130000Z", "SUMMARY:Z"]));
    expect(r.rows[0].startsAt).toBe("2027-03-14T13:00:00.000Z");
  });
});

describe("parseRaceIcs — nothing to read (AC 1)", () => {
  it("a calendar with no VEVENT returns an empty list and no problems", () => {
    expect(parseRaceIcs(calendar())).toEqual({ rows: [], problems: [] });
  });

  it("an empty string returns an empty list", () => {
    expect(parseRaceIcs("")).toEqual({ rows: [], problems: [] });
  });

  it("text that is not a calendar at all returns an empty list rather than throwing", () => {
    expect(parseRaceIcs("<html><body>not a calendar</body></html>")).toEqual({ rows: [], problems: [] });
  });
});

describe("parseRaceIcs — an unparseable DTSTART is reported by line, never thrown (AC 1)", () => {
  it("names the physical line of the bad DTSTART and still returns the good rows", () => {
    // Lines: 1 BEGIN:VCALENDAR 2 VERSION 3 PRODID 4 BEGIN:VEVENT 5 UID 6 DTSTART 7 SUMMARY
    // 8 END:VEVENT 9 BEGIN:VEVENT 10 UID 11 DTSTART(bad) 12 SUMMARY 13 END:VEVENT
    const r = parseRaceIcs(
      calendar(
        [UID, "DTSTART:20270411T170000Z", "SUMMARY:Good"],
        [UID, "DTSTART:next sunday at one", "SUMMARY:Bad"],
      ),
    );
    expect(r.rows.map((x) => x.title)).toEqual(["Good"]);
    expect(r.problems).toEqual([{ line: 11, message: 'DTSTART is not a date-time: "next sunday at one"' }]);
  });

  it.each([
    ["an all-day date", "DTSTART;VALUE=DATE:20270411", /all-day/],
    ["an unknown time zone", "DTSTART;TZID=Not/A_Zone:20270411T130000", /time zone this club cannot read: Not\/A_Zone/],
    ["a day that does not exist (floating)", "DTSTART:20270230T130000", /does not exist/],
    ["a day that does not exist (UTC)", "DTSTART:20270230T130000Z", /does not exist/],
    ["an impossible hour", "DTSTART:20270411T250000", /impossible time/],
    ["a date with no time part", "DTSTART:20270411", /not a date-time/],
  ])("%s is a problem on its own line, not a row", (_what, dtstart, message) => {
    const r = parseRaceIcs(calendar([UID, dtstart, "SUMMARY:x"]));
    expect(r.rows).toEqual([]);
    expect(r.problems).toEqual([{ line: 6, message: expect.stringMatching(message) }]);
  });

  it("a VEVENT with no DTSTART is reported on its BEGIN line", () => {
    const r = parseRaceIcs(calendar([UID, "SUMMARY:No start"]));
    expect(r.rows).toEqual([]);
    expect(r.problems).toEqual([{ line: 4, message: "VEVENT has no DTSTART" }]);
  });

  it("a VEVENT with no SUMMARY, or a blank one, has no title to give the race day", () => {
    const none = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z"]));
    expect(none.rows).toEqual([]);
    expect(none.problems).toEqual([{ line: 4, message: "VEVENT has no SUMMARY to use as the title" }]);
    const blank = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z", "SUMMARY:   "]));
    expect(blank.rows).toEqual([]);
    expect(blank.problems).toEqual([{ line: 7, message: "VEVENT has no SUMMARY to use as the title" }]);
  });

  it("a SUMMARY longer than the title column is a problem on the SUMMARY's line", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z", `SUMMARY:${"x".repeat(81)}`]));
    expect(r.rows).toEqual([]);
    expect(r.problems).toEqual([{ line: 7, message: "SUMMARY is longer than 80 characters" }]);
  });

  it("a VEVENT never closed is reported rather than dropped", () => {
    const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "DTSTART:20270411T170000Z", "SUMMARY:x"].join("\n");
    expect(parseRaceIcs(text)).toEqual({
      rows: [],
      problems: [{ line: 2, message: "VEVENT is never closed (no END:VEVENT)" }],
    });
  });
});

describe("parseRaceIcs — an RRULE event is flagged, not expanded (AC 1)", () => {
  it("returns one row for the first occurrence, marked unsupported", () => {
    const r = parseRaceIcs(
      calendar([UID, "DTSTART;TZID=America/New_York:20270411T130000", "RRULE:FREQ=WEEKLY;COUNT=10", "SUMMARY:Every Sunday"]),
    );
    expect(r.rows).toEqual([
      { startsAt: "2027-04-11T17:00:00.000Z", title: "Every Sunday", line: 4, unsupported: "rrule" },
    ]);
    expect(r.problems).toEqual([]);
  });

  it("an RDATE is the same case: one event, more than one date", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z", "RDATE:20270418T170000Z", "SUMMARY:Two"]));
    expect(r.rows.map((x) => x.unsupported)).toEqual(["rrule"]);
  });

  it("a plain event beside a recurring one is not flagged", () => {
    const r = parseRaceIcs(
      calendar(
        [UID, "DTSTART:20270411T170000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:Series"],
        [UID, "DTSTART:20270502T170000Z", "SUMMARY:Single"],
      ),
    );
    expect(r.rows.map((x) => [x.title, x.unsupported ?? null])).toEqual([
      ["Series", "rrule"],
      ["Single", null],
    ]);
  });
});

describe("parseRaceIcs — what a reader owes the format", () => {
  it("unfolds a continuation line and reports line numbers from the physical file", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Spring series 1 — the long",
      "  name continues here",
      "DTSTART:20270411T170000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:garbage",
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join(CRLF);
    const r = parseRaceIcs(text);
    expect(r.rows[0].title).toBe("Spring series 1 — the long name continues here");
    // Line 8, counted over physical lines: the fold above did not shift it.
    expect(r.problems).toEqual([{ line: 8, message: 'DTSTART is not a date-time: "garbage"' }]);
  });

  it("unescapes TEXT in the title and collapses a line break to a space", () => {
    const r = parseRaceIcs(calendar([UID, "DTSTART:20270411T170000Z", "SUMMARY:Spring\\, series\\; one\\\\two\\nthree"]));
    expect(r.rows[0].title).toBe("Spring, series; one\\two three");
  });

  it("reads LF line endings as well as CRLF", () => {
    const text = calendar([UID, "DTSTART:20270411T170000Z", "SUMMARY:LF"]).replace(/\r\n/g, "\n");
    expect(parseRaceIcs(text).rows.map((x) => x.title)).toEqual(["LF"]);
  });

  it("a VALARM inside the VEVENT does not retitle the race", () => {
    const r = parseRaceIcs(
      calendar([
        UID,
        "DTSTART:20270411T170000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "SUMMARY:Reminder",
        "TRIGGER:-PT15M",
        "END:VALARM",
        "SUMMARY:The race",
      ]),
    );
    expect(r.rows.map((x) => x.title)).toEqual(["The race"]);
  });

  it("property names are case-insensitive and a VTIMEZONE block is skipped (a Google export)", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "VERSION:2.0",
      "X-WR-TIMEZONE:America/New_York",
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "TZNAME:EDT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "dtstart;tzid=America/New_York:20270411T130000",
      "DTEND;TZID=America/New_York:20270411T160000",
      "DTSTAMP:20260901T120000Z",
      "UID:abc@google.com",
      "CREATED:20260901T120000Z",
      "DESCRIPTION:",
      "LAST-MODIFIED:20260901T120000Z",
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      "summary:Spring series 1",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join(CRLF);
    const r = parseRaceIcs(text);
    expect(r).toEqual({
      rows: [{ startsAt: "2027-04-11T17:00:00.000Z", title: "Spring series 1", line: 15 }],
      problems: [],
    });
  });

  it("contentLines: a colon inside a quoted parameter does not end the parameter list", () => {
    const [p] = contentLines('DTSTART;TZID="Odd:Zone";VALUE=DATE-TIME:20270411T130000');
    expect(p.name).toBe("DTSTART");
    expect(p.params.get("TZID")).toBe("Odd:Zone");
    expect(p.params.get("VALUE")).toBe("DATE-TIME");
    expect(p.value).toBe("20270411T130000");
  });

  it("unescapeText is the inverse of the writer's escaping", () => {
    expect(unescapeText("a\\,b\\;c\\\\d\\ne\\Nf")).toBe("a,b;c\\d\ne\nf");
  });
});

describe("planImport — a re-import inserts no duplicates (AC 3)", () => {
  const A = { startsAt: "2027-04-11T17:00:00.000Z", title: "Spring series 1" };
  const B = { startsAt: "2027-04-18T17:00:00.000Z", title: "Spring series 2" };

  it("inserts rows the calendar does not hold", () => {
    expect(planImport([A, B], [])).toEqual({ insert: [A, B], duplicates: [] });
  });

  it("skips a row the calendar holds, matched on the instant and the title", () => {
    // PostgREST spells the instant with +00:00; the match is on the instant, not the string.
    const existing = [{ starts_at: "2027-04-11T17:00:00+00:00", title: "Spring series 1" }];
    expect(planImport([A, B], existing)).toEqual({ insert: [B], duplicates: [A] });
  });

  it("the same instant with a different title is a different race day", () => {
    const existing = [{ starts_at: "2027-04-11T17:00:00+00:00", title: "Something else" }];
    expect(planImport([A], existing)).toEqual({ insert: [A], duplicates: [] });
  });

  it("the same title at a different instant is a different race day", () => {
    const existing = [{ starts_at: "2027-04-11T18:00:00+00:00", title: "Spring series 1" }];
    expect(planImport([A], existing)).toEqual({ insert: [A], duplicates: [] });
  });

  it("a file listing the same race twice inserts it once", () => {
    expect(planImport([A, { ...A }], [])).toEqual({ insert: [A], duplicates: [A] });
  });

  it("an unpublished existing row still counts as that race", () => {
    const existing = [{ starts_at: "2027-04-11T17:00:00+00:00", title: "Spring series 1" }];
    expect(planImport([A], existing).insert).toEqual([]);
  });

  it("titles are matched trimmed", () => {
    const existing = [{ starts_at: "2027-04-11T17:00:00+00:00", title: "Spring series 1  " }];
    expect(planImport([A], existing).duplicates).toEqual([A]);
  });
});

describe("readPublishRow — what the review form may send back", () => {
  it("reads a row and normalises the instant", () => {
    expect(readPublishRow(JSON.stringify({ startsAt: "2027-04-11T17:00:00+00:00", title: " Spring series 1 " })))
      .toEqual({ startsAt: "2027-04-11T17:00:00.000Z", title: "Spring series 1" });
  });

  it.each([
    ["not a string", 42],
    ["not JSON", "{nope"],
    ["not an object", JSON.stringify("x")],
    ["null", "null"],
    ["missing title", JSON.stringify({ startsAt: "2027-04-11T17:00:00Z" })],
    ["a non-string title", JSON.stringify({ startsAt: "2027-04-11T17:00:00Z", title: 3 })],
    ["an unreadable instant", JSON.stringify({ startsAt: "next sunday", title: "x" })],
    ["a blank title", JSON.stringify({ startsAt: "2027-04-11T17:00:00Z", title: "  " })],
    ["a title over 80", JSON.stringify({ startsAt: "2027-04-11T17:00:00Z", title: "x".repeat(81) })],
  ])("refuses %s", (_what, value) => {
    expect(readPublishRow(value)).toBeNull();
  });
});
