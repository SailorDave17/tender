/**
 * A crew's profile as the form submits it: the skills they ticked, either any hull or a set of
 * classes, and an optional phone. Pure, so every refusal is tested without a request, and the page
 * and the Server Action share one decision about what a valid profile is.
 *
 * Both lists are inputs rather than constants: `boat_class` (0005) and `skill` (0024) are seeded by
 * migration and read at request time, so a class or a skill added by a later migration is accepted
 * here with no code change — and a name that is not in the list is refused, which is the only check
 * the database does not make (both columns are text[]; there is no array foreign key).
 */

import type { Competence } from "@/engine/ladder";

/**
 * The competence scale, in ordinal order — the engine compares these with `<`, so the order of
 * this array IS the scale.
 *
 * Since #68 this is the SKIPPER-SIDE vocabulary and nothing else: /post/new and /boats offer it as
 * the one minimum a post will take, and /post/[id] prints that minimum back. The crew side is no
 * longer built from it — /profile ticks rows of `skill` (0024) and the person's `rating` is derived
 * from them — so a level added here appears in the two skipper forms, and a skill added to the
 * table appears on the profile. They are held together by `skill.level`, which is data.
 */
export const RATINGS: ReadonlyArray<{ value: Competence; label: string }> = [
  { value: 1, label: "Never raced" },
  { value: 2, label: "Can hike and trim" },
  { value: 3, label: "Can fly a spinnaker" },
  { value: 4, label: "Can helm" },
];

export function ratingLabel(rating: number | null | undefined): string {
  return RATINGS.find((r) => r.value === rating)?.label ?? "Not set";
}

/** A row of `skill` (0024), as every page reads it — ordered by `sort` at the query. */
export type Skill = {
  code: string;
  label: string;
  level: Competence;
  sort: number;
};

/**
 * The rung a ticked set of skills earns: the HIGHEST level among them.
 *
 * Highest and not lowest, and that is the whole of the derivation — a crew who can hike, trim and
 * helm is a helm, and taking the lowest would rank every honest person by the least they can do.
 * A set has no order, so this is where it becomes the ordinal the engine compares (ladder.ts).
 *
 * Refusals rather than a null level, so the caller cannot tell "nothing ticked" from "the ticked
 * set is not in the table" by accident — they are different messages and different fixes.
 */
export type LevelFromSkills =
  | { ok: true; level: Competence; codes: string[] }
  | { ok: false; reason: "blank-rating" | "unknown-skill" };

export function levelFromSkills(
  codes: readonly string[],
  skills: readonly Skill[],
): LevelFromSkills {
  const picked = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (picked.length === 0) return { ok: false, reason: "blank-rating" };

  const levels: Competence[] = [];
  for (const code of picked) {
    const skill = skills.find((s) => s.code === code);
    if (!skill) return { ok: false, reason: "unknown-skill" };
    levels.push(skill.level);
  }
  return { ok: true, level: Math.max(...levels) as Competence, codes: picked };
}

/**
 * "Never raced" ticked alongside anything else — the one combination that says two opposite things.
 *
 * Keyed on LEVEL 1 rather than on the code `never-raced`, because the seed is data the owner may
 * re-seed (0024's header says so) and a magic string here would stop matching without failing.
 * Level 1 is "has not raced" by the scale's own definition, so it contradicts every other tick.
 */
export function contradictsNeverRaced(codes: readonly string[], skills: readonly Skill[]): boolean {
  const picked = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  if (picked.length < 2) return false;
  return picked.some((code) => skills.find((s) => s.code === code)?.level === 1);
}

/**
 * The labels of the skills a person ticked, in the table's own `sort` order, for every place a
 * person's competence is shown to somebody else.
 *
 * Falls back to the single rating word when the set is empty, and that fallback is load-bearing
 * rather than defensive: a row written before 0024's backfill, or by an older client, has a rating
 * and no skills, and "Not set" for such a person would read to a skipper as somebody who never
 * filled the form in.
 */
export function competenceText(
  person: { rating: number | null | undefined; skills?: readonly string[] | null },
  skills: readonly Skill[],
): string {
  const ticked = new Set(person.skills ?? []);
  const labels = skills.filter((s) => ticked.has(s.code)).map((s) => s.label);
  return labels.length > 0 ? labels.join(", ") : ratingLabel(person.rating);
}

export type ProfileInput = {
  /** The skill codes ticked. Since #68 this is what the form sends; `rating` is derived from it. */
  skills: readonly string[];
  /** "any" or "some" — which radio the person picked. */
  hulls: string;
  /** The classes ticked; ignored when hulls is "any". */
  classes: readonly string[];
  phone: string;
};

export type ProfileRefusal =
  | "blank-rating"
  | "unknown-skill"
  | "contradictory-skills"
  | "no-hull-chosen"
  | "unknown-class"
  | "phone-invalid";

export type ParsedProfile =
  | {
      ok: true;
      rating: Competence;
      skills: string[];
      anyHull: boolean;
      hulls: string[];
      phone: string | null;
    }
  | { ok: false; reason: ProfileRefusal };

export const PHONE_MAX = 24;
// Digits with the usual separators; at least seven digits so "555" is not a phone.
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;

export function normalizePhone(raw: string): string | null | "invalid" {
  const phone = raw.trim();
  if (phone === "") return null;
  if (phone.length > PHONE_MAX) return "invalid";
  if (!PHONE_SHAPE.test(phone)) return "invalid";
  if (phone.replace(/\D/g, "").length < 7) return "invalid";
  return phone;
}

export function parseProfileForm(
  input: ProfileInput,
  knownClasses: readonly string[],
  knownSkills: readonly Skill[],
): ParsedProfile {
  // Nothing ticked keeps the blank-rating refusal it has had since 0005: `rating` can never be
  // null for someone who has saved, which is what the board's "set your competence first" banner
  // (src/availability/rules.ts) reads.
  const derived = levelFromSkills(input.skills, knownSkills);
  if (!derived.ok) return { ok: false, reason: derived.reason };
  if (contradictsNeverRaced(derived.codes, knownSkills)) {
    return { ok: false, reason: "contradictory-skills" };
  }

  const anyHull = input.hulls !== "some";
  const hulls = anyHull ? [] : [...new Set(input.classes.map((c) => c.trim()).filter(Boolean))];
  if (!anyHull && hulls.length === 0) return { ok: false, reason: "no-hull-chosen" };
  if (hulls.some((h) => !knownClasses.includes(h))) return { ok: false, reason: "unknown-class" };

  const phone = normalizePhone(input.phone);
  if (phone === "invalid") return { ok: false, reason: "phone-invalid" };

  return { ok: true, rating: derived.level, skills: derived.codes, anyHull, hulls, phone };
}

/** The message the person sees for a refusal. */
export function explainProfileRefusal(reason: string): string {
  switch (reason) {
    case "blank-rating":
      return "Pick how competent you are — skippers and the ladder go by it.";
    case "unknown-skill":
      return "One of those skills is not on the club's list.";
    case "contradictory-skills":
      return "Never raced contradicts the other skills you ticked — pick one or the others.";
    case "no-hull-chosen":
      return "Tick at least one class, or choose any hull.";
    case "unknown-class":
      return "One of those classes is not in the fleet list.";
    case "phone-invalid":
      return "That does not look like a phone number. Leave it blank if you would rather not give one.";
    case "refused":
      return "The database refused that change.";
    // #42: the account deletion's own refusals, keyed by the step that refused (delete-account.ts).
    case "delete-unconfirmed":
      return "Tick the box to confirm you want your account deleted.";
    case "delete-person":
      return "Your account was not deleted: the database refused it. Nothing has changed.";
    default:
      return "That could not be saved.";
  }
}
