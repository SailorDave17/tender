import { describe, expect, it } from "vitest";
import { explainProfileRefusal, type Skill } from "./profile";
import { NAME_MAX, explainWelcomeRefusal, parseWelcomeForm } from "./welcome";

/** 0024's seed, as a literal for the reason profile.test.ts gives: the module works off rows. */
const SKILLS: Skill[] = [
  { code: "never-raced", label: "Never raced", level: 1, sort: 1 },
  { code: "hike-trim", label: "Can hike and trim", level: 2, sort: 2 },
  { code: "spinnaker", label: "Can fly a spinnaker", level: 3, sort: 3 },
  { code: "helm", label: "Can helm", level: 4, sort: 4 },
];

const base = { displayName: "Ann", skills: [] as string[], phone: "", skip: false };

describe("parseWelcomeForm — the name is required (#219 AC 3)", () => {
  it("refuses an empty name, and a name of only spaces", () => {
    expect(parseWelcomeForm({ ...base, displayName: "" }, SKILLS)).toEqual({ ok: false, reason: "name-blank" });
    expect(parseWelcomeForm({ ...base, displayName: "   " }, SKILLS)).toEqual({ ok: false, reason: "name-blank" });
  });

  it("refuses an 81-character name and accepts an 80-character one — 0002's check, at its boundary", () => {
    expect(NAME_MAX).toBe(80);
    expect(parseWelcomeForm({ ...base, displayName: "a".repeat(81) }, SKILLS)).toEqual({
      ok: false,
      reason: "name-too-long",
    });
    const at = parseWelcomeForm({ ...base, displayName: "a".repeat(80) }, SKILLS);
    expect(at.ok && at.displayName).toBe("a".repeat(80));
  });

  it("refuses a too-long name even on Skip — skipping is for the optional fields, never the name", () => {
    expect(parseWelcomeForm({ ...base, displayName: "", skip: true }, SKILLS)).toEqual({ ok: false, reason: "name-blank" });
    expect(parseWelcomeForm({ ...base, displayName: "a".repeat(81), skip: true }, SKILLS)).toEqual({
      ok: false,
      reason: "name-too-long",
    });
  });

  it("trims the name it keeps", () => {
    const r = parseWelcomeForm({ ...base, displayName: "  Ann Lee  " }, SKILLS);
    expect(r).toEqual({ ok: true, displayName: "Ann Lee", competence: undefined, phone: null });
  });
});

describe("parseWelcomeForm — phone and experience are optional (#219 AC 3)", () => {
  it("a valid name with the optional fields empty is a finished profile that sets no rating", () => {
    expect(parseWelcomeForm(base, SKILLS)).toEqual({
      ok: true,
      displayName: "Ann",
      competence: undefined,
      phone: null,
    });
  });

  it("ticked skills set the rating the same way /profile does — the highest level ticked", () => {
    const r = parseWelcomeForm({ ...base, skills: ["hike-trim", "helm"] }, SKILLS);
    expect(r).toEqual({
      ok: true,
      displayName: "Ann",
      competence: { rating: 4, skills: ["hike-trim", "helm"] },
      phone: null,
    });
  });

  it("refuses what /profile refuses, with /profile's own codes and sentences", () => {
    expect(parseWelcomeForm({ ...base, skills: ["telepathy"] }, SKILLS)).toEqual({ ok: false, reason: "unknown-skill" });
    expect(parseWelcomeForm({ ...base, skills: ["never-raced", "helm"] }, SKILLS)).toEqual({
      ok: false,
      reason: "contradictory-skills",
    });
    expect(parseWelcomeForm({ ...base, phone: "555" }, SKILLS)).toEqual({ ok: false, reason: "phone-invalid" });
    // The sentences are /profile's, so there is one copy of each.
    expect(explainWelcomeRefusal("phone-invalid")).toBeNull();
    expect(explainProfileRefusal("phone-invalid")).toMatch(/does not look like a phone number/);
  });

  it("keeps a valid phone", () => {
    const r = parseWelcomeForm({ ...base, phone: " 614-555-0100 " }, SKILLS);
    expect(r.ok && r.phone).toBe("614-555-0100");
  });

  it("Skip for now keeps the name and ignores the optional fields entirely, even invalid ones", () => {
    expect(parseWelcomeForm({ ...base, skills: ["helm"], phone: "555", skip: true }, SKILLS)).toEqual({
      ok: true,
      displayName: "Ann",
    });
  });
});

describe("explainWelcomeRefusal", () => {
  it("says something for each name refusal", () => {
    expect(explainWelcomeRefusal("name-blank")).toMatch(/your name/);
    expect(explainWelcomeRefusal("name-too-long")).toContain("80 characters");
  });
});
