/**
 * "Finish your profile" (/welcome, story #219) as the form submits it: a name, which is required,
 * and the two things /profile also asks — the skills a member can do and a phone — which are not.
 * Pure, so every refusal is tested without a request, and the page and its Server Action share one
 * decision about what a finished profile is.
 *
 * The optional half reuses /profile's own rules rather than copying them: `levelFromSkills` and
 * `contradictsNeverRaced` for the skills, `normalizePhone` for the phone, and the same refusal
 * codes, so `explainProfileRefusal` is the one place a sentence lives. What differs is only that an
 * EMPTY skill set is not a refusal here — on /profile it is `blank-rating`, because that page is
 * where the rating gets set; here "Skip for now" is a promise, and the board's "set your competence"
 * banner is what follows the member who took it.
 */

import { contradictsNeverRaced, levelFromSkills, normalizePhone, type Skill } from "./profile";
import type { Competence } from "@/engine/ladder";

/** The same limits as `person.display_name` (0002's check) and the sign-up form's name field. */
export const NAME_MIN = 1;
export const NAME_MAX = 80;

export type WelcomeInput = {
  displayName: string;
  skills: readonly string[];
  phone: string;
  /** "Skip for now" was pressed: keep the name, ignore whatever optional fields were filled. */
  skip: boolean;
};

export type WelcomeRefusal =
  | "name-blank"
  | "name-too-long"
  | "unknown-skill"
  | "contradictory-skills"
  | "phone-invalid";

export type ParsedWelcome =
  | {
      ok: true;
      displayName: string;
      /** Absent when nothing was ticked or the member skipped — the rating is then left alone. */
      competence?: { rating: Competence; skills: string[] };
      /** Absent when the member skipped; `null` when they left it blank. */
      phone?: string | null;
    }
  | { ok: false; reason: WelcomeRefusal };

export function parseWelcomeForm(input: WelcomeInput, knownSkills: readonly Skill[]): ParsedWelcome {
  const displayName = input.displayName.trim();
  if (displayName.length < NAME_MIN) return { ok: false, reason: "name-blank" };
  if (displayName.length > NAME_MAX) return { ok: false, reason: "name-too-long" };

  if (input.skip) return { ok: true, displayName };

  const ticked = input.skills.map((s) => s.trim()).filter(Boolean);
  let competence: { rating: Competence; skills: string[] } | undefined;
  if (ticked.length > 0) {
    const derived = levelFromSkills(ticked, knownSkills);
    // The set is non-empty, so the one refusal left to levelFromSkills is a code not in the list.
    if (!derived.ok) return { ok: false, reason: "unknown-skill" };
    if (contradictsNeverRaced(derived.codes, knownSkills)) return { ok: false, reason: "contradictory-skills" };
    competence = { rating: derived.level, skills: derived.codes };
  }

  const phone = normalizePhone(input.phone);
  if (phone === "invalid") return { ok: false, reason: "phone-invalid" };

  return { ok: true, displayName, competence, phone };
}

/** The message the member sees for a refusal — the name's own, and /profile's for the rest. */
export function explainWelcomeRefusal(reason: string): string | null {
  switch (reason) {
    case "name-blank":
      return "Tell the club your name — it is how skippers and crew will know you.";
    case "name-too-long":
      return `Keep your name to ${NAME_MAX} characters.`;
    default:
      return null;
  }
}
