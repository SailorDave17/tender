import { describe, expect, it } from "vitest";
import { explainProfileRefusal, normalizePhone, parseProfileForm, ratingLabel } from "./profile";

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

  it("refuses no rating, or one outside 1..3", () => {
    expect(parseProfileForm({ ...base, rating: "" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
    expect(parseProfileForm({ ...base, rating: "4" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
    expect(parseProfileForm({ ...base, rating: "helm" }, FLEET)).toEqual({ ok: false, reason: "blank-rating" });
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
  it("ratingLabel names the three competences and 'Not set' for none", () => {
    expect(ratingLabel(1)).toBe("Never raced");
    expect(ratingLabel(2)).toBe("Can hike and trim");
    expect(ratingLabel(3)).toBe("Can helm");
    expect(ratingLabel(null)).toBe("Not set");
  });
  it("every refusal has its own message", () => {
    const reasons = ["blank-rating", "no-hull-chosen", "unknown-class", "phone-invalid", "refused"];
    const messages = reasons.map(explainProfileRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages).not.toContain(explainProfileRefusal("something-else"));
  });
});
