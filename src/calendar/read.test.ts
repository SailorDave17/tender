import { describe, expect, it } from "vitest";
import { matchUrl, raceIcsForViewer, renderRaceIcs, type RaceIcsInputs } from "./read";

/**
 * The download route's decision (story #34, AC 2): /match/[id]/race.ics serves the file to the
 * skipper and the crew, and nothing — a 404 — to anyone else. The route itself is a thin shell
 * over this (getUser, readRaceIcsInputs, then this); it is driven on a running stack for the
 * part no unit test can see.
 */

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SITE = "https://tender.example.org";

const inputs = (over: Partial<RaceIcsInputs> = {}): RaceIcsInputs => ({
  matchId: "33333333-3333-4333-8333-333333333333",
  postId: "11111111-1111-4111-8111-111111111111",
  skipperId: SKIPPER,
  crewId: CREW,
  acceptedAt: "2027-06-06T11:59:00Z",
  skipperName: "Sam Skipper",
  boatClass: "Thistle",
  note: "",
  startsAt: "2027-06-13T17:00:00Z",
  clubName: "Hoover Sailing Club",
  ...over,
});

describe("raceIcsForViewer — either party, and nobody else", () => {
  it("serves the same file to the skipper and to the crew", () => {
    const toSkipper = raceIcsForViewer(SKIPPER, inputs(), SITE);
    const toCrew = raceIcsForViewer(CREW, inputs(), SITE);
    expect(toSkipper).not.toBeNull();
    expect(toSkipper).toBe(toCrew);
    expect(toSkipper).toBe(renderRaceIcs(inputs(), SITE));
    expect(toSkipper).toContain("BEGIN:VEVENT");
  });

  it("serves nothing to a third member, to a signed-out request, or for a match that is not there", () => {
    expect(raceIcsForViewer(THIRD, inputs(), SITE)).toBeNull();
    expect(raceIcsForViewer(null, inputs(), SITE)).toBeNull();
    expect(raceIcsForViewer(SKIPPER, null, SITE)).toBeNull();
  });

  it("throws rather than serving a file with a hole in it (the route answers 500)", () => {
    expect(() => raceIcsForViewer(CREW, inputs({ clubName: null }), SITE)).toThrow(/club name is blank/);
    expect(() => raceIcsForViewer(CREW, inputs({ skipperName: null }), SITE)).toThrow(/skipper name is blank/);
  });
});

describe("matchUrl — the post page, where the match panel is", () => {
  it("joins the origin and the post id, with or without a trailing slash", () => {
    expect(matchUrl(SITE, "p1")).toBe(`${SITE}/post/p1`);
    expect(matchUrl(`${SITE}/`, "p1")).toBe(`${SITE}/post/p1`);
  });

  it("the file's DESCRIPTION carries it", () => {
    const ics = renderRaceIcs(inputs(), SITE).replace(/\r\n /g, "");
    expect(ics).toContain(`DESCRIPTION:${SITE}/post/11111111-1111-4111-8111-111111111111\r\n`);
  });
});
