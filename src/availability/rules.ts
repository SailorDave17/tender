/**
 * Whether a person may mark a race day, and what the board shows about each day. Pure, over an
 * injected `now`, so the two refusals the board disables buttons for — a day already gone, a
 * person with no rating — are tested without a request and applied again in the Server Action,
 * where a disabled button is no defence (story #18 AC 4, AC 5).
 *
 * The database holds the rating rule too (0005's insert policy), so a direct PostgREST insert
 * from an unrated person is refused there whatever this says. The past-date rule is only here:
 * the policy would need `now()`, and a rule about the present is easier to read and test at
 * this level than inside a policy.
 */

export type AvailabilityRefusal = "no-rating" | "past";

/** A race day is past once its start has gone — a race this afternoon is still markable. */
export function isPast(startsAt: string | Date, now: Date): boolean {
  return new Date(startsAt).getTime() <= now.getTime();
}

export function availabilityRefusal(
  person: { rating: number | null },
  date: { starts_at: string | Date },
  now: Date,
): AvailabilityRefusal | null {
  if (person.rating == null) return "no-rating";
  if (isPast(date.starts_at, now)) return "past";
  return null;
}

export type AvailabilityRow = { person_id: string; race_date_id: string };

/** Per race date: how many people can sail it, and whether `me` is one of them. */
export function summarise(
  rows: readonly AvailabilityRow[],
  me: string,
): Map<string, { count: number; mine: boolean }> {
  const out = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    const s = out.get(r.race_date_id) ?? { count: 0, mine: false };
    s.count += 1;
    if (r.person_id === me) s.mine = true;
    out.set(r.race_date_id, s);
  }
  return out;
}

/** The message the person sees for a refusal. */
export function explainAvailabilityRefusal(reason: string): string {
  switch (reason) {
    case "no-rating":
      return "Set your competence on your profile before marking a day.";
    case "past":
      return "That race day has already started.";
    case "refused":
      return "The database refused that change.";
    default:
      return "That could not be saved.";
  }
}
