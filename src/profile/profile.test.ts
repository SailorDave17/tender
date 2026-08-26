import { describe, expect, it } from "vitest";
import { RATINGS, explainProfileRefusal, normalizePhone, parseProfileForm, ratingLabel } from "./profile";

const FLEET = ["Flying Scot", "Highlander", "Interlake", "MC Scow", "Thistle", "Windmill"];
const base = { rating: "2", hulls: "any", classes: [], phone: "" };

describe("parseProfileForm — what a valid profile is (AC 2)", () => {
  it("accepts a rating with any hull and no phone", () => {
    expect(parseProfileForm(base, FLEET)).toEqual({
      ok: true,
      rating: 2,
      anyHull: true,
      hulls: [],
      phone: null,
    });
  });

  it("accepts a set of classes from the fleet list, deduplicated, when hulls is 'some'", () => {
    const r = parseProfileForm(
      { ...base, hulls: "some", classes: ["Thistle", "Flying Scot", "Thistle", " "] },
      FLEET,
    );
    expect(r).toEqual({ ok: true, rating: 2, anyHull: false, hulls: ["Thistle", "Flying Scot"], phone: null });
  });

  it("ignores ticked classes when hulls is 'any' — the flag wins, as in the schema", () => {
    const r = parseProfileForm({ ...base, hulls: "any", classes: ["Thistle"] }, FLEET);
    expect(r).toEqual({ ok: true, rating: 2, anyHull: true, hulls: [], phone: null });
  });

  it("refuses no rating, or one outside 1..4", () => {
    expect(parseProfileForm({ ...base, rating: "" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
    expect(parseProfileForm({ ...base, rating: "0" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
    expect(parseProfileForm({ ...base, rating: "5" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
    expect(parseProfileForm({ ...base, rating: "helm" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
  });

  // #69: the scale widened rather than shifted, so BOTH new-scale ends must be accepted here —
  // a check narrowed back to 1..3 refuses 4, and one shifted to 2..5 refuses 1.
  it("accepts every level of the four-level scale, spinnaker and helm included", () => {
    for (const rating of ["1", "2", "3", "4"]) {
      const r = parseProfileForm({ ...base, rating }, FLEET);
      expect(r).toMatchObject({ ok: true, rating: Number(rating) });
    }
  });

  it("refuses 'some' with nothing ticked — the state 0005's check constraint refuses too", () => {
    expect(parseProfileForm({ ...base, hulls: "some", classes: [] }, FLEET)).toEqual({
      ok: false,
      reason: "no-hull-chosen",
    });
  });

  it("refuses a class that is not in the fleet list", () => {
    expect(parseProfileForm({ ...base, hulls: "some", classes: ["Thistle", "Laser"] }, FLEET)).toEqual({
      ok: false,
      reason: "unknown-class",
    });
  });

  it("carries a phone through trimmed, and refuses one that is not a phone", () => {
    expect(parseProfileForm({ ...base, phone: " 614-555-0100 " }, FLEET)).toMatchObject({
      ok: true,
      phone: "614-555-0100",
    });
    expect(parseProfileForm({ ...base, phone: "call me" }, FLEET)).toEqual({ ok: false, reason: "phone-invalid" });
  });
});

describe("normalizePhone", () => {
  it("blank is null (no phone given), not invalid", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });
  it("accepts the usual shapes", () => {
    expect(normalizePhone("(614) 555-0100")).toBe("(614) 555-0100");
    expect(normalizePhone("+1 614 555 0100")).toBe("+1 614 555 0100");
    expect(normalizePhone("6145550100")).toBe("6145550100");
  });
  it("refuses letters, too few digits, and too long", () => {
    expect(normalizePhone("614-555-O1OO")).toBe("invalid");
    expect(normalizePhone("555")).toBe("invalid");
    expect(normalizePhone("1".repeat(25))).toBe("invalid");
  });
});

describe("labels", () => {
  it("ratingLabel names the four competences and 'Not set' for none", () => {
    expect(ratingLabel(1)).toBe("Never raced");
    expect(ratingLabel(2)).toBe("Can hike and trim");
    expect(ratingLabel(3)).toBe("Can fly a spinnaker");
    expect(ratingLabel(4)).toBe("Can helm");
    expect(ratingLabel(null)).toBe("Not set");
  });

  // RATINGS' ORDER is the scale — the engine compares these with `<` and all three radio groups
  // render in array order, so a reordering is a silent product change that no type can catch.
  it("RATINGS is the four levels in ordinal order, values 1..4 with no gap", () => {
    expect(RATINGS.map((r) => r.value)).toEqual([1, 2, 3, 4]);
    expect(RATINGS.map((r) => r.label)).toEqual([
      "Never raced",
      "Can hike and trim",
      "Can fly a spinnaker",
      "Can helm",
    ]);
  });
  it("every refusal has its own message", () => {
    const reasons = ["blank-rating", "no-hull-chosen", "unknown-class", "phone-invalid", "refused"];
    const messages = reasons.map(explainProfileRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages).not.toContain(explainProfileRefusal("something-else"));
  });
});
