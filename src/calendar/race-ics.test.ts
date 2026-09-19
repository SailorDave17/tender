import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import { escapeText, fold, raceIcs, utcStamp, type IcsClub, type IcsMatch, type IcsPost, type IcsRaceDate } from "./race-ics";

/**
 * raceIcs() (story #34, AC 1): a golden file for the exact bytes, then the three format rules
 * each on their own, then a parse-back through ical.js — an independent RFC 5545 parser, so the
 * file is judged by something that did not write it. The golden alone would only prove the
 * output is what this module's author believed the format to be.
 */

const MATCH: IcsMatch = {
  id: "33333333-3333-4333-8333-333333333333",
  acceptedAt: "2027-06-06T11:59:00Z",
  skipperName: "Sam Skipper",
  url: "https://tender.example.org/post/11111111-1111-4111-8111-111111111111",
};
const POST: IcsPost = { boatClass: "Thistle", note: "Bring gloves" };
// 1 pm on a June Sunday in Ohio (EDT) is 17:00Z.
const DATE: IcsRaceDate = { startsAt: "2027-06-13T17:00:00Z" };
const CLUB: IcsClub = { name: "Hoover Sailing Club" };

// The snapshot, written out by hand so a reviewer reads the file rather than trusting a
// generated one: every line CRLF-terminated, the 96-octet DESCRIPTION folded at 75.
const GOLDEN = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Tender//Crew board//EN",
  "CALSCALE:GREGORIAN",
  "METHOD:PUBLISH",
  "BEGIN:VEVENT",
  "UID:33333333-3333-4333-8333-333333333333@tender.madcowsailing.com",
  "DTSTAMP:20270606T115900Z",
  "DTSTART:20270613T170000Z",
  "DURATION:PT3H",
  "SUMMARY:Thistle with Sam Skipper — Hoover Sailing Club",
  "DESCRIPTION:Bring gloves\\n\\nhttps://tender.example.org/post/11111111-1111-4",
  " 111-8111-111111111111",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const octets = (s: string) => Buffer.byteLength(s, "utf8");
const physicalLines = (ics: string) => ics.split("\r\n").slice(0, -1);
// Built from code points rather than written as escapes or literals, so this source stays plain
// printable text: U+FFFD is what a split UTF-8 sequence decodes to, 0x07 is a stray BEL.
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);
const BEL = String.fromCharCode(0x07);

describe("raceIcs — the file (snapshot)", () => {
  it("renders exactly the golden file", () => {
    expect(raceIcs(MATCH, POST, DATE, CLUB)).toBe(GOLDEN);
  });

  it("is CRLF throughout: no bare LF, no bare CR, and ends with CRLF", () => {
    const ics = raceIcs(MATCH, POST, DATE, CLUB);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("an empty note leaves the URL alone in DESCRIPTION", () => {
    const ics = raceIcs(MATCH, { ...POST, note: "   " }, DATE, CLUB).replace(/\r\n /g, "");
    expect(ics).toContain(`\r\nDESCRIPTION:${MATCH.url}\r\n`);
  });
});

describe("raceIcs — 75-octet folding", () => {
  // A note long enough to fold several times, with 3-byte characters (em-dash, ⛵ is 3 bytes in
  // the BMP) placed so a naive character-count fold or a byte fold that splits a character fails.
  const long = "Meet at the dock — bring gloves, a hat; and water. ".repeat(4) + "⛵".repeat(30);

  it("no physical line exceeds 75 octets, and every continuation starts with one space", () => {
    const lines = physicalLines(raceIcs(MATCH, { ...POST, note: long }, DATE, CLUB));
    const continuations = lines.filter((l) => l.startsWith(" "));
    expect(continuations.length).toBeGreaterThan(3); // the fixture actually folds
    for (const l of lines) expect(octets(l)).toBeLessThanOrEqual(75);
  });

  it("never splits a UTF-8 character across lines", () => {
    const ics = raceIcs(MATCH, { ...POST, note: long }, DATE, CLUB);
    const lines = physicalLines(ics);
    // Guard the loop: with no CRLF at all there would be no lines, and it would pass on nothing.
    expect(lines.filter((l) => l.startsWith(" ") && /⛵/.test(l)).length).toBeGreaterThan(0);
    for (const l of lines) {
      // A split sequence re-decodes as U+FFFD; a whole one round-trips.
      expect(Buffer.from(l, "utf8").toString("utf8")).toBe(l);
      expect(l).not.toContain(REPLACEMENT_CHAR);
    }
  });

  it("fold() splits at the octet limit, counting the leading space toward the next line", () => {
    const line = "X".repeat(75 + 74 + 10);
    const parts = fold(line).split("\r\n");
    expect(parts.map(octets)).toEqual([75, 75, 11]);
    expect(parts[1].startsWith(" ")).toBe(true);
    expect(fold("X".repeat(75))).toBe("X".repeat(75)); // exactly 75 is not folded
    // A 3-byte character that would straddle octet 75 moves whole to the next line.
    const straddle = fold("X".repeat(74) + "—" + "Y");
    expect(straddle.split("\r\n").map(octets)).toEqual([74, 1 + 3 + 1]);
  });
});

describe("raceIcs — TEXT escaping", () => {
  it("escapes backslash, semicolon, comma and line breaks; drops other control characters", () => {
    expect(escapeText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
    expect(escapeText(`bell${BEL}tab\there`)).toBe("belltab\there");
  });

  it("a skipper name or club carrying ; and , does not break the SUMMARY", () => {
    const ics = raceIcs({ ...MATCH, skipperName: "Lee, Jr.; R" }, POST, DATE, { name: "Club, Inc." });
    expect(ics).toContain("SUMMARY:Thistle with Lee\\, Jr.\\; R — Club\\, Inc.\r\n");
  });
});

describe("raceIcs — refuses what it cannot render (feeds #34 AC 3)", () => {
  it.each([
    ["an unparseable start", () => raceIcs(MATCH, POST, { startsAt: "not a date" }, CLUB), /starts_at is not a date/],
    ["an empty start", () => raceIcs(MATCH, POST, { startsAt: "" }, CLUB), /starts_at is not a date/],
    ["an unparseable accepted_at", () => raceIcs({ ...MATCH, acceptedAt: "x" }, POST, DATE, CLUB), /accepted_at is not a date/],
    ["a blank skipper name", () => raceIcs({ ...MATCH, skipperName: " " }, POST, DATE, CLUB), /skipper name is blank/],
    ["a blank club name", () => raceIcs(MATCH, POST, DATE, { name: "" }), /club name is blank/],
    ["a blank boat class", () => raceIcs(MATCH, { ...POST, boatClass: "" }, DATE, CLUB), /boat class is blank/],
  ])("throws on %s", (_name, render, reason) => {
    expect(render).toThrow(reason);
  });

  it("utcStamp is the UTC basic form, milliseconds dropped", () => {
    expect(utcStamp("2027-11-07T06:30:00.250Z", "x")).toBe("20271107T063000Z");
  });
});

describe("raceIcs — parse-back through an independent parser (ical.js)", () => {
  const parse = (ics: string) => {
    const cal = new ICAL.Component(ICAL.parse(ics));
    return { cal, events: cal.getAllSubcomponents("vevent") };
  };

  it("is one VCALENDAR with exactly one VEVENT carrying every filed field", () => {
    const { cal, events } = parse(raceIcs(MATCH, POST, DATE, CLUB));
    expect(cal.name).toBe("vcalendar");
    expect(cal.getFirstPropertyValue("version")).toBe("2.0");
    expect(events).toHaveLength(1);

    const e = new ICAL.Event(events[0]);
    expect(e.uid).toBe(`${MATCH.id}@tender.madcowsailing.com`);
    expect(e.startDate.toJSDate().toISOString()).toBe("2027-06-13T17:00:00.000Z");
    expect(e.startDate.zone?.tzid).toBe("UTC");
    expect(e.duration.toSeconds()).toBe(3 * 60 * 60);
    expect(e.endDate.toJSDate().toISOString()).toBe("2027-06-13T20:00:00.000Z");
    expect(e.summary).toBe("Thistle with Sam Skipper — Hoover Sailing Club");
    expect(e.description).toBe(`Bring gloves\n\n${MATCH.url}`);
  });

  it("round-trips a folded, escaped, multi-byte note to the exact text typed", () => {
    const note = "Meet at the dock — bring gloves, a hat; and water.\nBack slash \\ too. " + "⛵".repeat(30);
    const { events } = parse(raceIcs(MATCH, { ...POST, note }, DATE, CLUB));
    expect(new ICAL.Event(events[0]).description).toBe(`${note}\n\n${MATCH.url}`);
  });
});
