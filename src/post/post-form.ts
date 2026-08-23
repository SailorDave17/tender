/**
 * A skipper's two forms — a boat, and a need posted against a race date — as pure decisions,
 * so every refusal is tested without a request and the Server Actions only wire them.
 *
 * The database refuses most of this again (0006: class is a foreign key, minimum is a check,
 * the owner and the date's state are policies, the pair is unique). These checks exist so the
 * person gets a sentence rather than a 42501, and so a refusal can be named in a test.
 */

import type { Competence } from "@/engine/ladder";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BOAT_NAME_MAX = 80;
export const NOTE_MAX = 280;

export type BoatInput = { name: string; class: string; minimum: string };
export type BoatRefusal = "blank-name" | "name-too-long" | "unknown-class" | "blank-minimum";
export type ParsedBoat =
  | { ok: true; name: string; boatClass: string; minimum: Competence }
  | { ok: false; reason: BoatRefusal };

function competence(raw: string): Competence | null {
  const n = Number(raw);
  return n === 1 || n === 2 || n === 3 ? n : null;
}

export function parseBoatForm(input: BoatInput, knownClasses: readonly string[]): ParsedBoat {
  const name = input.name.trim();
  if (name.length < 1) return { ok: false, reason: "blank-name" };
  if (name.length > BOAT_NAME_MAX) return { ok: false, reason: "name-too-long" };
  const boatClass = input.class.trim();
  if (!knownClasses.includes(boatClass)) return { ok: false, reason: "unknown-class" };
  const minimum = competence(input.minimum);
  if (!minimum) return { ok: false, reason: "blank-minimum" };
  return { ok: true, name, boatClass, minimum };
}

export type PostInput = { boatId: string; raceDateId: string; minimum: string; note: string };
export type PostRefusal = "no-boat" | "no-date" | "blank-minimum" | "note-too-long";
export type ParsedPost =
  | { ok: true; boatId: string; raceDateId: string; minimum: Competence; note: string }
  | { ok: false; reason: PostRefusal };

export function parsePostForm(input: PostInput): ParsedPost {
  if (!UUID.test(input.boatId)) return { ok: false, reason: "no-boat" };
  if (!UUID.test(input.raceDateId)) return { ok: false, reason: "no-date" };
  const minimum = competence(input.minimum);
  if (!minimum) return { ok: false, reason: "blank-minimum" };
  const note = input.note.trim();
  if (note.length > NOTE_MAX) return { ok: false, reason: "note-too-long" };
  return { ok: true, boatId: input.boatId, raceDateId: input.raceDateId, minimum, note };
}

/** The message the skipper sees for a refusal, on either form. */
export function explainPostRefusal(reason: string): string {
  switch (reason) {
    case "blank-name":
      return "Give the boat a name.";
    case "name-too-long":
      return `Keep the boat's name to ${BOAT_NAME_MAX} characters.`;
    case "unknown-class":
      return "Pick the boat's class from the fleet list.";
    case "blank-minimum":
      return "Pick the minimum competence you will take.";
    case "no-boat":
      return "Pick which boat needs crew.";
    case "no-date":
      return "Pick the race day.";
    case "note-too-long":
      return `Keep the note to ${NOTE_MAX} characters.`;
    case "duplicate":
      return "That boat already has a post for that day — close it first if you want to change it.";
    case "refused":
      return "The database refused that. Only the boat's owner can post for it, and only against a published race day that has not started.";
    default:
      return "That could not be saved.";
  }
}
