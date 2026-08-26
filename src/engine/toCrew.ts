import type { Competence, Crew } from "./ladder";

/**
 * A person row, as 0005 stores it, into the engine's Crew — the one place the schema's explicit
 * any_hull flag meets the engine's "empty hulls means any hull".
 *
 * The two disagree on purpose. The engine reads `hulls: []` as any hull (ladder.ts), and it
 * must: a rung-1 match needs `hulls.includes(boatClass)` to be trivially true for an any-hull
 * crew. The schema cannot use the same convention, because an empty array there would also be
 * the state of someone who has not chosen yet — so 0005 carries any_hull explicitly and refuses
 * `any_hull = false` with nothing chosen. This function is where the flag wins: when any_hull is
 * true the stored array is dropped whatever it holds, and when false the chosen classes go
 * through. Tested in both directions beside this file, because the inversion would be silent —
 * a crew who chose Thistle only would be proposed for every hull, or an any-hull crew for none.
 *
 * A person with no rating is not a Crew: the engine ranks by rating, and 0005's policy refuses
 * such a person an availability row anyway. Returning null rather than inventing a rung keeps
 * the caller honest about who is in the pool.
 */

export interface PersonRow {
  id: string;
  rating: number | null;
  any_hull: boolean;
  hulls: readonly string[];
}

export function toCrew(row: PersonRow, available: boolean): Crew | null {
  if (row.rating !== 1 && row.rating !== 2 && row.rating !== 3 && row.rating !== 4) return null;
  return {
    id: row.id,
    rating: row.rating as Competence,
    hulls: row.any_hull ? [] : [...row.hulls],
    available,
  };
}
