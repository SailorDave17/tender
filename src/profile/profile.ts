/**
 * A crew's profile as the form submits it: a rating, either any hull or a set of classes, and an
 * optional phone. Pure, so every refusal is tested without a request, and the page and the
 * Server Action share one decision about what a valid profile is.
 *
 * The class list is an input rather than a constant: boat_class is seeded by migration (0005)
 * and read at request time, so a class added by a later migration is accepted here with no
 * code change — and a class name that is not in the list is refused, which is the only check
 * the database does not make (hulls is text[]; there is no array foreign key).
 */

import type { Competence } from "@/engine/ladder";

export const RATINGS: ReadonlyArray<{ value: Competence; label: string }> = [
  { value: 1, label: "Never raced" },
  { value: 2, label: "Can hike and trim" },
  { value: 3, label: "Can helm" },
];

export function ratingLabel(rating: number | null | undefined): string {
  return RATINGS.find((r) => r.value === rating)?.label ?? "Not set";
}

export type ProfileInput = {
  rating: string;
  /** "any" or "some" — which radio the person picked. */
  hulls: string;
  /** The classes ticked; ignored when hulls is "any". */
  classes: readonly string[];
  phone: string;
};

export type ProfileRefusal =
  | "blank-rating"
  | "no-hull-chosen"
  | "unknown-class"
  | "phone-invalid";

export type ParsedProfile =
  | {
      ok: true;
      rating: Competence;
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

export function parseProfileForm(input: ProfileInput, knownClasses: readonly string[]): ParsedProfile {
  const rating = Number(input.rating);
  if (rating !== 1 && rating !== 2 && rating !== 3) return { ok: false, reason: "blank-rating" };

  const anyHull = input.hulls !== "some";
  const hulls = anyHull ? [] : [...new Set(input.classes.map((c) => c.trim()).filter(Boolean))];
  if (!anyHull && hulls.length === 0) return { ok: false, reason: "no-hull-chosen" };
  if (hulls.some((h) => !knownClasses.includes(h))) return { ok: false, reason: "unknown-class" };

  const phone = normalizePhone(input.phone);
  if (phone === "invalid") return { ok: false, reason: "phone-invalid" };

  return { ok: true, rating, anyHull, hulls, phone };
}

/** The message the person sees for a refusal. */
export function explainProfileRefusal(reason: string): string {
  switch (reason) {
    case "blank-rating":
      return "Pick how competent you are — skippers and the ladder go by it.";
    case "no-hull-chosen":
      return "Tick at least one class, or choose any hull.";
    case "unknown-class":
      return "One of those classes is not in the fleet list.";
    case "phone-invalid":
      return "That does not look like a phone number. Leave it blank if you would rather not give one.";
    case "refused":
      return "The database refused that change.";
    default:
      return "That could not be saved.";
  }
}
