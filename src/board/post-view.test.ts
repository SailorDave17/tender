import { describe, expect, it } from "vitest";
import type { Crew } from "@/engine/ladder";
import { RUNG_COLOUR, candidateRows, poolForDate, viewPost } from "./post-view";

/**
 * Story #19 AC 4, with a fixed clock: >48 h and a rung-1 crew available → 1; >48 h and only
 * rung-2 crew → 2 (emptiness); 30 h → 2 (clock); 20 h → 3 (clock). Plus AC 5's ordering and
 * the 'not yet notified' mark.
 */

const startsAt = new Date("2027-04-11T17:00:00Z");
const hoursBefore = (h: number) => new Date(startsAt.getTime() - h * 60 * 60 * 1000);
const post = { starts_at: startsAt.toISOString(), boatClass: "Thistle", minimum: 2 as const, current_rung: 1 as const };

const crew = (id: string, rating: 1 | 2 | 3, hulls: string[]): Crew => ({ id, rating, hulls, available: true });
const ann = crew("ann", 3, ["Thistle"]); // rung 1
const bo = crew("bo", 2, []); // rung 1 (any hull)
const cy = crew("cy", 2, ["Flying Scot"]); // rung 2
const di = crew("di", 1, ["Thistle"]); // rung 3

describe("viewPost — the open rung with a fixed clock (AC 4)", () => {
  it("more than 48 h out with a rung-1 crew available → rung 1, green", () => {
    const v = viewPost(post, [ann, cy, di], hoursBefore(72));
    expect(v.rung).toBe(1);
    expect(v.colour).toEqual(RUNG_COLOUR[1]);
    expect(v.colour.name).toBe("green");
    expect(v.candidateCount).toBe(1);
    expect(v.clockRung).toBe(1);
  });

  it("more than 48 h out with only rung-2 crew → rung 2 by emptiness, amber", () => {
    const v = viewPost(post, [cy, di], hoursBefore(72));
    expect(v.rung).toBe(2);
    expect(v.colour.name).toBe("amber");
    expect(v.candidateCount).toBe(1);
    expect(v.clockRung).toBe(1); // the clock did not do this
  });

  it("30 h out → rung 2 by the clock, even with rung-1 crew available", () => {
    const v = viewPost(post, [ann, cy], hoursBefore(30));
    expect(v.rung).toBe(2);
    expect(v.clockRung).toBe(2);
    expect(v.candidateCount).toBe(2); // ann and cy both on or above rung 2
  });

  it("47 h out → rung 2 (the AC's own example)", () => {
    expect(viewPost(post, [ann], hoursBefore(47)).rung).toBe(2);
  });

  it("20 h out → rung 3 by the clock, red", () => {
    const v = viewPost(post, [ann, cy, di], hoursBefore(20));
    expect(v.rung).toBe(3);
    expect(v.colour.name).toBe("red");
    expect(v.candidateCount).toBe(3);
  });

  it("nobody available far out → rung 3 with no candidates (the floor, never hidden)", () => {
    const v = viewPost(post, [], hoursBefore(72));
    expect(v).toMatchObject({ rung: 3, candidateCount: 0, clockRung: 1 });
  });

  it("every rung has a distinct colour and the number is what the page prints", () => {
    const names = new Set(Object.values(RUNG_COLOUR).map((c) => c.name));
    expect(names.size).toBe(3);
  });
});

describe("viewPost / candidateRows — the stored rung wins over a narrower computed one (story #23 AC 4)", () => {
  it("a post stored at rung 2 shows 2 when suggest() would say 1, and the rung-1 crew is still counted", () => {
    // A rung-1 crew marked the day after rung 2 was notified: suggest() alone reads 1 here
    // (ann is rung 1, far out), and the board must not un-tell rung 2.
    const stored2 = { ...post, current_rung: 2 as const };
    expect(viewPost(post, [ann, cy], hoursBefore(72)).rung).toBe(1); // the control: same pool, stored 1
    const v = viewPost(stored2, [ann, cy], hoursBefore(72));
    expect(v.rung).toBe(2);
    expect(v.colour.name).toBe("amber");
    expect(v.candidateCount).toBe(2); // ann (1) and cy (2) are both on or above the open rung
    expect(v.clockRung).toBe(1); // and it was not the clock
  });

  it("a wider computed rung still wins over a narrower stored one — the clock half is not persisted yet", () => {
    const stored2 = { ...post, current_rung: 2 as const };
    expect(viewPost(stored2, [ann, cy, di], hoursBefore(20)).rung).toBe(3);
    expect(viewPost(stored2, [], hoursBefore(72)).rung).toBe(3); // emptiness on read, as before
  });

  it("candidateRows marks rung-2 crew as notified on a post stored at 2 even when rung 1 is populated", () => {
    const stored2 = { ...post, current_rung: 2 as const };
    const byId = (rows: ReturnType<typeof candidateRows>) => Object.fromEntries(rows.map((r) => [r.id, r.notified]));
    expect(byId(candidateRows(post, [ann, cy, di], hoursBefore(72)))).toEqual({ ann: true, cy: false, di: false });
    expect(byId(candidateRows(stored2, [ann, cy, di], hoursBefore(72)))).toEqual({ ann: true, cy: true, di: false });
  });
});

describe("candidateRows — every available crew, best rung first, reached or not (AC 5)", () => {
  it("orders by rung and marks rungs the post has not reached as not notified", () => {
    const rows = candidateRows(post, [di, cy, ann, bo], hoursBefore(72));
    expect(rows.map((r) => [r.id, r.rung, r.notified])).toEqual([
      ["ann", 1, true],
      ["bo", 1, true],
      ["cy", 2, false],
      ["di", 3, false],
    ]);
  });

  it("once the clock opens rung 2, the rung-2 crew is notified and rung 3 still is not", () => {
    const rows = candidateRows(post, [di, cy, ann], hoursBefore(30));
    expect(rows.map((r) => [r.id, r.notified])).toEqual([
      ["ann", true],
      ["cy", true],
      ["di", false],
    ]);
  });

  it("emptiness widens too: with no rung-1 crew, rung-2 is reached far out", () => {
    const rows = candidateRows(post, [di, cy], hoursBefore(72));
    expect(rows.map((r) => [r.id, r.notified])).toEqual([
      ["cy", true],
      ["di", false],
    ]);
  });

  it("carries each row's colour", () => {
    const rows = candidateRows(post, [di], hoursBefore(72));
    expect(rows[0].colour).toEqual(RUNG_COLOUR[3]);
  });

  it("with nobody answered, every row says so", () => {
    expect(candidateRows(post, [ann, cy], hoursBefore(72)).every((r) => r.answered === false)).toBe(true);
  });
});

describe("candidateRows — answerers first, above the non-answering pool (story #20 AC 4)", () => {
  it("lists answerers first, each by rung, then the rest by rung, each with their own rung", () => {
    const rows = candidateRows(post, [di, cy, ann, bo], hoursBefore(72), new Set(["cy", "di"]));
    expect(rows.map((r) => [r.id, r.rung, r.answered])).toEqual([
      ["cy", 2, true],
      ["di", 3, true],
      ["ann", 1, false],
      ["bo", 1, false],
    ]);
    expect(rows[0].colour).toEqual(RUNG_COLOUR[2]); // the answerer keeps their rungOf colour
  });

  it("an answerer is never 'not yet notified', whatever their rung against the open one", () => {
    const rows = candidateRows(post, [di, cy, ann], hoursBefore(72), new Set(["di"]));
    expect(rows.map((r) => [r.id, r.notified])).toEqual([
      ["di", true], // rung 3, below the open rung 1 — but they answered
      ["ann", true],
      ["cy", false],
    ]);
  });

  it("an answerer who is no longer available is still listed; a non-answerer who is not available is not", () => {
    const gone = { ...cy, available: false };
    const neverWas = { ...di, available: false };
    const rows = candidateRows(post, [ann, gone, neverWas], hoursBefore(72), new Set(["cy"]));
    expect(rows.map((r) => r.id)).toEqual(["cy", "ann"]);
  });

  it("does not count an unavailable answerer toward the open rung (the ladder's pool is the available)", () => {
    // Only di (rung 3) is available; cy answered earlier and unmarked the day. The open rung is
    // 3 by emptiness, so ann-less di is notified; cy's answer does not pull the rung back to 2.
    const gone = { ...cy, available: false };
    const rows = candidateRows(post, [gone, di], hoursBefore(72), new Set(["cy"]));
    expect(rows.map((r) => [r.id, r.notified])).toEqual([
      ["cy", true],
      ["di", true],
    ]);
  });
});

describe("poolForDate — the date's available crew as the engine sees them", () => {
  const people = [
    { id: "ann", rating: 3, any_hull: false, hulls: ["Thistle"] },
    { id: "bo", rating: 2, any_hull: true, hulls: ["Windmill"] },
    { id: "cy", rating: null, any_hull: true, hulls: [] },
  ];
  const availability = [
    { person_id: "ann", race_date_id: "d1" },
    { person_id: "bo", race_date_id: "d2" },
    { person_id: "cy", race_date_id: "d1" },
  ];

  it("keeps only people with an availability row for that date, rated, with any_hull applied", () => {
    const pool = poolForDate(people, availability, "d1");
    expect(pool).toEqual([{ id: "ann", rating: 3, hulls: ["Thistle"], available: true }]); // cy is unrated
    const d2 = poolForDate(people, availability, "d2");
    expect(d2).toEqual([{ id: "bo", rating: 2, hulls: [], available: true }]); // any_hull drops Windmill
  });

  it("is empty for a date nobody marked", () => {
    expect(poolForDate(people, availability, "d3")).toEqual([]);
  });
});
