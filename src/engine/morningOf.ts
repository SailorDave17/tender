import { CLUB_TZ, localDate } from "@/dates/race-date";
import type { RungPost } from "@/notify/rung";

/**
 * The morning-of pass — the second thing the ladder tick does (story #37 AC 2). On the morning
 * of a race, every crew still merely `accepted` on a match for that day is asked to confirm:
 * a push if they have one, an email with a Confirm link, and `match.reminded_at` set so the
 * next tick asks nobody twice.
 *
 * IT RIDES THE EXISTING TICK, so there is one clock (the issue's own reasoning). `handleTick()`
 * runs the ladder pass, dispatches, then calls this, then stamps `tick_run` — a reminder pass
 * that threw leaves the stamp unmoved, the same rule the ladder half lives under.
 *
 * THE DECISION IS HERE, NOT IN THE QUERY, and that is deliberate. The repo hands back every
 * candidate — accepted, not yet reminded — and `reminderDue()` decides which are due against
 * the club's wall clock. A PostgREST filter on an embedded resource (the race date's start,
 * reached through the post) is applied to the EMBED and leaves the parent with a null, which
 * no SQL harness can reproduce (cairn: postgrest-filtering-on-an-embedded-resource); a
 * predicate over an injected `now` is testable at every boundary that matters — 05:59 and
 * 06:00, the night before, a DST day — without waiting for a morning in Ohio. The candidate set
 * is small by construction: a match is reminded on its race day or never, so the set is the
 * season's future matches plus whatever was matched before this shipped.
 *
 * WHEN A REMINDER IS DUE (owner decisions at pickup, 2026-09-18; decision H at filing):
 *
 *   - `now` is on the race date's calendar day in America/New_York, and
 *   - the wall clock there reads REMINDER_HOUR (06:00) or later, and
 *   - the race has not started — a "confirm this morning" sent after the boat left is noise, and
 *     the skipper is marking sailed or no-show by then. A tick catching up after a paused project
 *     therefore sends nothing for a race that already sailed, and the negative case is a named
 *     test rather than an assumption.
 *
 * WHAT IT DOES NOT DO: send, or mark. `remind` is injected — the route hands in
 * `remindCrewLive` (src/notify/live.ts), which owns the two channels, the cap and the log, and
 * sets `reminded_at` after the attempt whatever the provider answered. Keeping the two apart is
 * what makes this testable through a pglite adapter with real SQL, exactly as `runTick()` is.
 */

/** The hour, on the club's wall clock, from which the reminder may go. Decision H (2026-08-22). */
export const REMINDER_HOUR = 6;

/** A match the pass may act on: still `accepted`, not yet reminded, with the post it sits on. */
export type MorningMatch = {
  id: string;
  skipperId: string;
  crewId: string;
  /** The post as the notifications read it — boat, class, date, start. */
  post: RungPost;
};

export interface MorningOfRepo {
  /**
   * Every match with status `accepted` and `reminded_at` null. No time filter here on purpose —
   * see the module docstring — so the adapter is a plain read and the rule lives in one place.
   */
  candidates(): Promise<MorningMatch[]>;
}

/** The club-zone hour (0–23) at an instant. */
function localHour(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CLUB_TZ, hourCycle: "h23", hour: "2-digit" }).formatToParts(instant);
  return Number(parts.find((p) => p.type === "hour")?.value);
}

/**
 * Whether the reminder for a race starting at `startsAt` is due at `now`. Pure; the three
 * conditions in the module docstring, in that order.
 */
export function reminderDue(startsAt: string, now: Date): boolean {
  const race = new Date(startsAt);
  if (localDate(now) !== localDate(race)) return false;
  if (localHour(now) < REMINDER_HOUR) return false;
  return now.getTime() < race.getTime();
}

export type MorningOfResult = {
  /** Candidates read — accepted and not yet reminded. Not "reminded": a quiet pass still reports its work. */
  candidates: number;
  /** The matches this pass handed to `remind`, in the order it did. */
  due: string[];
};

/**
 * Ask every crew whose race morning it is to confirm. Reads and decides; `remind` sends.
 * A `remind` that throws propagates — the live wrapper swallows per match, so one bad address
 * does not stop the next crew being asked, and a pass that cannot read at all leaves the tick's
 * stamp unmoved.
 */
export async function runMorningOf(
  repo: MorningOfRepo,
  remind: (match: MorningMatch) => Promise<void>,
  now: Date,
): Promise<MorningOfResult> {
  const candidates = await repo.candidates();
  const due: string[] = [];
  for (const match of candidates) {
    if (!reminderDue(match.post.startsAt, now)) continue;
    await remind(match);
    due.push(match.id);
  }
  return { candidates: candidates.length, due };
}
