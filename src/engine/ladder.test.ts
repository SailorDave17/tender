import { describe, expect, it } from "vitest";
import {
  RUNG_2_BEFORE_MS,
  RUNG_3_BEFORE_MS,
  rungOf,
  rungOpenedByClock,
  suggest,
  type Crew,
  type Post,
} from "./ladder";

// A race a week away; the clock opens nothing on its own.
const raceAt = new Date("2026-09-06T17:45:00Z");
const farOut = new Date(raceAt.getTime() - 7 * 24 * 60 * 60 * 1000);
const post: Post = { raceAt, boatClass: "Thistle", minimum: 2 };

const crew = (id: string, rating: 1 | 2 | 3, hulls: string[], available = true): Crew => ({
  id,
  rating,
  hulls,
  available,
});

const onClassQualified = crew("ann", 3, ["Thistle"]);
const anyHullQualified = crew("bo", 2, []);
const otherHullQualified = crew("cy", 2, ["Flying Scot"]);
const onClassUnderRated = crew("di", 1, ["Thistle"]);
const unavailableQualified = crew("ed", 3, ["Thistle"], false);

describe("rungOf", () => {
  it("puts hull-willing, qualified crew on rung 1", () => {
    expect(rungOf(post, onClassQualified)).toBe(1);
    expect(rungOf(post, anyHullQualified)).toBe(1); // empty hulls means any hull
  });
  it("puts qualified crew unwilling on this hull on rung 2", () => {
    expect(rungOf(post, otherHullQualified)).toBe(2);
  });
  it("puts under-rated crew on rung 3 whatever their hull", () => {
    expect(rungOf(post, onClassUnderRated)).toBe(3);
  });
});

describe("rungOpenedByClock", () => {
  it("opens rung 1 more than 48 h out, 2 inside 48 h, 3 inside 24 h", () => {
    const t = (ms: number) => new Date(raceAt.getTime() - ms);
    expect(rungOpenedByClock(post, t(RUNG_2_BEFORE_MS + 1))).toBe(1);
    expect(rungOpenedByClock(post, t(RUNG_2_BEFORE_MS))).toBe(2);
    expect(rungOpenedByClock(post, t(RUNG_3_BEFORE_MS + 1))).toBe(2);
    expect(rungOpenedByClock(post, t(RUNG_3_BEFORE_MS))).toBe(3);
  });
});

describe("suggest", () => {
  it("stays on rung 1 and proposes only rung-1 crew when one is available", () => {
    const s = suggest(post, [onClassQualified, otherHullQualified, onClassUnderRated], farOut);
    expect(s.rung).toBe(1);
    expect(s.candidates.map((c) => c.crew.id)).toEqual(["ann"]);
  });

  it("widens to rung 2 on emptiness, not on the clock", () => {
    const s = suggest(post, [otherHullQualified, onClassUnderRated], farOut);
    expect(s.rung).toBe(2);
    expect(s.candidates.map((c) => c.crew.id)).toEqual(["cy"]);
  });

  it("widens to rung 3 when only under-rated crew are available", () => {
    const s = suggest(post, [onClassUnderRated, unavailableQualified], farOut);
    expect(s.rung).toBe(3);
    expect(s.candidates.map((c) => c.crew.id)).toEqual(["di"]);
  });

  it("widens on the clock even when rung-1 crew exist, and keeps them first", () => {
    const insideTwoDays = new Date(raceAt.getTime() - RUNG_2_BEFORE_MS + 1);
    const s = suggest(post, [otherHullQualified, onClassQualified], insideTwoDays);
    expect(s.rung).toBe(2);
    expect(s.candidates.map((c) => [c.crew.id, c.rung])).toEqual([
      ["ann", 1],
      ["cy", 2],
    ]);
  });

  it("never proposes someone who is not available", () => {
    const s = suggest(post, [unavailableQualified], farOut);
    expect(s.rung).toBe(3);
    expect(s.candidates).toEqual([]);
  });
});
