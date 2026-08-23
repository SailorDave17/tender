import { describe, expect, it } from "vitest";
import { explainPostRefusal, parseBoatForm, parsePostForm } from "./post-form";

const FLEET = ["Flying Scot", "Highlander", "Interlake", "MC Scow", "Thistle", "Windmill"];
const BOAT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("parseBoatForm (AC 2)", () => {
  it("accepts a name, a fleet class and a minimum, trimming the name", () => {
    expect(parseBoatForm({ name: " Blue Moon ", class: "Thistle", minimum: "2" }, FLEET)).toEqual({
      ok: true,
      name: "Blue Moon",
      boatClass: "Thistle",
      minimum: 2,
    });
  });
  it("refuses a blank or over-long name", () => {
    expect(parseBoatForm({ name: "  ", class: "Thistle", minimum: "2" }, FLEET)).toEqual({ ok: false, reason: "blank-name" });
    expect(parseBoatForm({ name: "x".repeat(81), class: "Thistle", minimum: "2" }, FLEET)).toEqual({
      ok: false,
      reason: "name-too-long",
    });
  });
  it("refuses a class outside the fleet list", () => {
    expect(parseBoatForm({ name: "Blue Moon", class: "Laser", minimum: "2" }, FLEET)).toEqual({ ok: false, reason: "unknown-class" });
  });
  // #69: the scale is 1..4, so 0 and 5 are the boundaries now — 4 is a helm and must be accepted.
  it("accepts every level of the four-level scale as a minimum", () => {
    for (const minimum of ["1", "2", "3", "4"]) {
      expect(parseBoatForm({ name: "Blue Moon", class: "Thistle", minimum }, FLEET)).toMatchObject({
        ok: true,
        minimum: Number(minimum),
      });
      expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum, note: "" })).toMatchObject({
        ok: true,
        minimum: Number(minimum),
      });
    }
  });

  it("refuses a missing or out-of-range minimum", () => {
    expect(parseBoatForm({ name: "Blue Moon", class: "Thistle", minimum: "" }, FLEET)).toEqual({ ok: false, reason: "blank-minimum" });
    expect(parseBoatForm({ name: "Blue Moon", class: "Thistle", minimum: "0" }, FLEET)).toEqual({ ok: false, reason: "blank-minimum" });
    expect(parseBoatForm({ name: "Blue Moon", class: "Thistle", minimum: "5" }, FLEET)).toEqual({ ok: false, reason: "blank-minimum" });
  });
});

describe("parsePostForm (AC 2)", () => {
  it("accepts a boat, a date, a minimum and a trimmed note", () => {
    expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum: "3", note: " Jib trimmer wanted " })).toEqual({
      ok: true,
      boatId: BOAT,
      raceDateId: DATE,
      minimum: 3,
      note: "Jib trimmer wanted",
    });
  });
  it("refuses a missing boat or date (anything that is not a uuid)", () => {
    expect(parsePostForm({ boatId: "", raceDateId: DATE, minimum: "2", note: "" })).toEqual({ ok: false, reason: "no-boat" });
    expect(parsePostForm({ boatId: BOAT, raceDateId: "tomorrow", minimum: "2", note: "" })).toEqual({ ok: false, reason: "no-date" });
  });
  it("refuses a blank minimum and an over-long note", () => {
    expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum: "", note: "" })).toEqual({ ok: false, reason: "blank-minimum" });
    expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum: "0", note: "" })).toEqual({ ok: false, reason: "blank-minimum" });
    expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum: "5", note: "" })).toEqual({ ok: false, reason: "blank-minimum" });
    expect(parsePostForm({ boatId: BOAT, raceDateId: DATE, minimum: "2", note: "x".repeat(281) })).toEqual({
      ok: false,
      reason: "note-too-long",
    });
  });
});

describe("messages", () => {
  it("every refusal has its own message, including the two the database produces", () => {
    const reasons = ["blank-name", "name-too-long", "unknown-class", "blank-minimum", "no-boat", "no-date", "note-too-long", "duplicate", "refused"];
    const messages = reasons.map(explainPostRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages).not.toContain(explainPostRefusal("else"));
    expect(explainPostRefusal("duplicate")).toMatch(/already has a post/);
  });
});
