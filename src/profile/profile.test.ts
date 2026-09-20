import { describe, expect, it } from "vitest";
import {
  RATINGS,
  competenceText,
  contradictsNeverRaced,
  explainProfileRefusal,
  levelFromSkills,
  normalizePhone,
  parseProfileForm,
  ratingLabel,
  type Skill,
} from "./profile";

const FLEET = ["Flying Scot", "Highlander", "Interlake", "MC Scow", "Thistle", "Windmill"];

/**
 * 0024's seed, as every page reads it — ordered by `sort`. A literal rather than an import: the
 * point of the skill table is that these are ROWS, so the pure module must work off whatever it
 * is handed, and a test that imported the same constant the code did would prove nothing about
 * that (#68 AC 3).
 */
const SKILLS: Skill[] = [
  { code: "never-raced", label: "Never raced", level: 1, sort: 1 },
  { code: "hike-trim", label: "Can hike and trim", level: 2, sort: 2 },
  { code: "spinnaker", label: "Can fly a spinnaker", level: 3, sort: 3 },
  { code: "helm", label: "Can helm", level: 4, sort: 4 },
];

const base = { skills: ["hike-trim"], hulls: "any", classes: [], phone: "" };

describe("levelFromSkills — the rung a ticked set earns (AC 3)", () => {
  it("refuses nothing ticked", () => {
    expect(levelFromSkills([], SKILLS)).toEqual({ ok: false, reason: "blank-rating" });
    // Blank strings are not a tick: an empty checkbox value would otherwise read as a skill.
    expect(levelFromSkills(["", "  "], SKILLS)).toEqual({ ok: false, reason: "blank-rating" });
  });

  it("one skill is its own level", () => {
    expect(levelFromSkills(["hike-trim"], SKILLS)).toEqual({ ok: true, level: 2, codes: ["hike-trim"] });
  });

  it("spinnaker alone is 3 — its own level, not trim's and not helm's (#69's scale)", () => {
    expect(levelFromSkills(["spinnaker"], SKILLS)).toEqual({ ok: true, level: 3, codes: ["spinnaker"] });
  });

  /**
   * The two cases that decide HIGHEST versus lowest, and they are the reason this function
   * exists rather than a `Math.min` being equally plausible: a crew who can hike, trim AND fly a
   * spinnaker is a spinnaker hand, and one who can also helm is a helm. Taking the lowest would
   * rank every honest person by the least they can do and quietly sink them down the ladder.
   */
  it("hike-trim + spinnaker is 3, the highest of the two", () => {
    expect(levelFromSkills(["hike-trim", "spinnaker"], SKILLS)).toMatchObject({ ok: true, level: 3 });
  });

  it("spinnaker + helm is 4, the highest of the two", () => {
    expect(levelFromSkills(["spinnaker", "helm"], SKILLS)).toMatchObject({ ok: true, level: 4 });
  });

  it("order of the ticks does not change the answer", () => {
    expect(levelFromSkills(["helm", "hike-trim"], SKILLS)).toMatchObject({ level: 4 });
    expect(levelFromSkills(["hike-trim", "helm"], SKILLS)).toMatchObject({ level: 4 });
  });

  it("refuses a code that is not in the table", () => {
    expect(levelFromSkills(["foredeck"], SKILLS)).toEqual({ ok: false, reason: "unknown-skill" });
    // …even beside a real one, so a crafted POST cannot smuggle one through on a valid tick.
    expect(levelFromSkills(["helm", "foredeck"], SKILLS)).toEqual({ ok: false, reason: "unknown-skill" });
  });

  it("deduplicates and trims the codes it returns", () => {
    expect(levelFromSkills([" helm ", "helm", ""], SKILLS)).toEqual({
      ok: true,
      level: 4,
      codes: ["helm"],
    });
  });

  /**
   * The list is an input, not a constant — a skill the club adds by migration must work here
   * with no code change (0024's header). This is the case that would fail against a hard-coded
   * four-code map, which is the obvious wrong implementation.
   */
  it("reads levels off the list it is given, so a skill added by migration works", () => {
    const withForedeck: Skill[] = [...SKILLS, { code: "foredeck", label: "Can do foredeck", level: 3, sort: 5 }];
    expect(levelFromSkills(["foredeck"], withForedeck)).toMatchObject({ ok: true, level: 3 });
    expect(levelFromSkills(["foredeck", "hike-trim"], withForedeck)).toMatchObject({ ok: true, level: 3 });
  });
});

describe("contradictsNeverRaced (AC 4)", () => {
  it("is false for never-raced alone, and for any set without it", () => {
    expect(contradictsNeverRaced(["never-raced"], SKILLS)).toBe(false);
    expect(contradictsNeverRaced(["hike-trim", "helm"], SKILLS)).toBe(false);
    expect(contradictsNeverRaced([], SKILLS)).toBe(false);
  });

  it("is true for never-raced beside any other skill", () => {
    expect(contradictsNeverRaced(["never-raced", "helm"], SKILLS)).toBe(true);
    expect(contradictsNeverRaced(["hike-trim", "never-raced"], SKILLS)).toBe(true);
  });

  // Keyed on LEVEL 1, not on the string "never-raced": 0024's seed is data the owner may re-seed,
  // and a magic code here would stop matching without failing.
  it("keys on level 1 rather than on the code, so a re-seeded list still contradicts", () => {
    const reseeded: Skill[] = [
      { code: "no-racing-yet", label: "Never raced", level: 1, sort: 1 },
      { code: "helm", label: "Can helm", level: 4, sort: 2 },
    ];
    expect(contradictsNeverRaced(["no-racing-yet", "helm"], reseeded)).toBe(true);
    expect(contradictsNeverRaced(["no-racing-yet"], reseeded)).toBe(false);
  });
});

describe("parseProfileForm — what a valid profile is (AC 2, AC 3, AC 4)", () => {
  it("accepts a ticked skill with any hull and no phone, and derives the rating", () => {
    expect(parseProfileForm(base, FLEET, SKILLS)).toEqual({
      ok: true,
      rating: 2,
      skills: ["hike-trim"],
      anyHull: true,
      hulls: [],
      phone: null,
    });
  });

  it("stores every ticked code and derives the rating from the highest", () => {
    expect(parseProfileForm({ ...base, skills: ["hike-trim", "spinnaker"] }, FLEET, SKILLS)).toMatchObject({
      ok: true,
      rating: 3,
      skills: ["hike-trim", "spinnaker"],
    });
  });

  it("accepts a set of classes from the fleet list, deduplicated, when hulls is 'some'", () => {
    const r = parseProfileForm(
      { ...base, hulls: "some", classes: ["Thistle", "Flying Scot", "Thistle", " "] },
      FLEET,
      SKILLS,
    );
    expect(r).toMatchObject({ ok: true, rating: 2, anyHull: false, hulls: ["Thistle", "Flying Scot"], phone: null });
  });

  it("ignores ticked classes when hulls is 'any' — the flag wins, as in the schema", () => {
    const r = parseProfileForm({ ...base, hulls: "any", classes: ["Thistle"] }, FLEET, SKILLS);
    expect(r).toMatchObject({ ok: true, rating: 2, anyHull: true, hulls: [] });
  });

  // AC 4: nothing ticked keeps the refusal /profile has had since 0005, so `rating` can never be
  // null for someone who has saved and the board's no-rating banner goes on meaning what it says.
  it("refuses nothing ticked, with the existing blank-rating reason", () => {
    expect(parseProfileForm({ ...base, skills: [] }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "blank-rating",
    });
  });

  it("refuses a skill code that is not on the club's list", () => {
    expect(parseProfileForm({ ...base, skills: ["foredeck"] }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "unknown-skill",
    });
  });

  it("refuses never-raced ticked together with another skill", () => {
    expect(parseProfileForm({ ...base, skills: ["never-raced", "helm"] }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "contradictory-skills",
    });
  });

  it("accepts never-raced on its own — it is a tick, not the absence of one", () => {
    expect(parseProfileForm({ ...base, skills: ["never-raced"] }, FLEET, SKILLS)).toMatchObject({
      ok: true,
      rating: 1,
      skills: ["never-raced"],
    });
  });

  // #69: the scale widened rather than shifted, so BOTH ends must come through — a derivation
  // narrowed back to 1..3 loses the helm, and one shifted to 2..5 loses never-raced.
  it("reaches every level of the four-level scale, spinnaker and helm included", () => {
    for (const s of SKILLS) {
      expect(parseProfileForm({ ...base, skills: [s.code] }, FLEET, SKILLS)).toMatchObject({
        ok: true,
        rating: s.level,
      });
    }
  });

  it("refuses 'some' with nothing ticked — the state 0005's check constraint refuses too", () => {
    expect(parseProfileForm({ ...base, hulls: "some", classes: [] }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "no-hull-chosen",
    });
  });

  it("refuses a class that is not in the fleet list", () => {
    expect(parseProfileForm({ ...base, hulls: "some", classes: ["Thistle", "Laser"] }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "unknown-class",
    });
  });

  it("carries a phone through trimmed, and refuses one that is not a phone", () => {
    expect(parseProfileForm({ ...base, phone: " 614-555-0100 " }, FLEET, SKILLS)).toMatchObject({
      ok: true,
      phone: "614-555-0100",
    });
    expect(parseProfileForm({ ...base, phone: "call me" }, FLEET, SKILLS)).toEqual({
      ok: false,
      reason: "phone-invalid",
    });
  });
});

describe("competenceText — what a skipper reads (AC 5)", () => {
  it("names every ticked skill, in the table's sort order rather than the tick order", () => {
    expect(competenceText({ rating: 3, skills: ["spinnaker", "hike-trim"] }, SKILLS)).toBe(
      "Can hike and trim, Can fly a spinnaker",
    );
  });

  it("names one skill on its own", () => {
    expect(competenceText({ rating: 4, skills: ["helm"] }, SKILLS)).toBe("Can helm");
  });

  /**
   * The fallback, and it is load-bearing: a row written before 0024's backfill, or by an older
   * client, carries a rating and no skills. "Not set" for such a person reads to a skipper as
   * somebody who never filled the form in, which is the opposite of the truth.
   */
  it("falls back to the rating label for a person with a rating and no skills", () => {
    expect(competenceText({ rating: 3, skills: [] }, SKILLS)).toBe("Can fly a spinnaker");
    expect(competenceText({ rating: 4, skills: null }, SKILLS)).toBe("Can helm");
    expect(competenceText({ rating: 2 }, SKILLS)).toBe("Can hike and trim");
  });

  it("is 'Not set' only for somebody with neither", () => {
    expect(competenceText({ rating: null, skills: [] }, SKILLS)).toBe("Not set");
  });

  it("falls back rather than printing a raw code when the list does not explain the ticks", () => {
    expect(competenceText({ rating: 4, skills: ["foredeck"] }, SKILLS)).toBe("Can helm");
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

  // RATINGS' ORDER is the scale — the engine compares these with `<` and both skipper-side
  // selectors render in array order, so a reordering is a silent product change no type catches.
  // Since #68 the crew side is built from `skill` instead; this is the skipper's vocabulary.
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
    const reasons = [
      "blank-rating",
      "unknown-skill",
      "contradictory-skills",
      "no-hull-chosen",
      "unknown-class",
      "phone-invalid",
      "refused",
    ];
    const messages = reasons.map(explainProfileRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    expect(messages).not.toContain(explainProfileRefusal("something-else"));
  });
});
