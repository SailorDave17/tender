import { describe, expect, it } from "vitest";
import { rungOf, type Post } from "./ladder";
import { toCrew } from "./toCrew";

/**
 * Story #18 AC 3: any_hull true → hulls [] regardless of the stored array; false → the chosen
 * classes. Both directions, and each is then pushed through rungOf so the test is about what
 * the engine does with the result, not only about the array's shape.
 */

const thistlePost: Post = { raceAt: new Date("2027-04-11T17:00:00Z"), boatClass: "Thistle", minimum: 2 };

describe("toCrew — any_hull carries into the engine's 'empty means any'", () => {
  it("any_hull true drops the stored array, even when it holds classes", () => {
    const crew = toCrew({ id: "bo", rating: 2, any_hull: true, hulls: ["Flying Scot"] }, true);
    expect(crew).toEqual({ id: "bo", rating: 2, hulls: [], available: true });
    expect(rungOf(thistlePost, crew!)).toBe(1); // any hull: rung 1 on a Thistle post
  });

  it("any_hull false passes the chosen classes through", () => {
    const crew = toCrew({ id: "ann", rating: 3, any_hull: false, hulls: ["Flying Scot"] }, true);
    expect(crew).toEqual({ id: "ann", rating: 3, hulls: ["Flying Scot"], available: true });
    expect(rungOf(thistlePost, crew!)).toBe(2); // willing on Scots only: rung 2 on a Thistle post
  });

  it("any_hull false with the post's class is rung 1 — the chosen list is read, not discarded", () => {
    const crew = toCrew({ id: "ann", rating: 3, any_hull: false, hulls: ["Thistle"] }, true);
    expect(rungOf(thistlePost, crew!)).toBe(1);
  });

  it("copies the array rather than aliasing the row's", () => {
    const hulls = ["Thistle"];
    const crew = toCrew({ id: "ann", rating: 3, any_hull: false, hulls }, true);
    hulls.push("Windmill");
    expect(crew!.hulls).toEqual(["Thistle"]);
  });

  it("carries availability through unchanged", () => {
    expect(toCrew({ id: "bo", rating: 2, any_hull: true, hulls: [] }, false)!.available).toBe(false);
  });

  it("a person with no rating, or one outside 1..4, is not a Crew", () => {
    expect(toCrew({ id: "cy", rating: null, any_hull: true, hulls: [] }, true)).toBeNull();
    expect(toCrew({ id: "cy", rating: 5, any_hull: true, hulls: [] }, true)).toBeNull();
    expect(toCrew({ id: "cy", rating: 0, any_hull: true, hulls: [] }, true)).toBeNull();
  });

  // #69: 3 (spinnaker) and 4 (helm) are both real ratings now. A guard narrowed back to 1..3
  // drops every helm out of the pool silently — the person simply stops being suggested.
  it("a spinnaker hand and a helm are both Crew", () => {
    expect(toCrew({ id: "di", rating: 3, any_hull: true, hulls: [] }, true)).toMatchObject({ rating: 3 });
    expect(toCrew({ id: "ed", rating: 4, any_hull: true, hulls: [] }, true)).toMatchObject({ rating: 4 });
  });
});
