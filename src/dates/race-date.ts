/**
 * Race dates as the admin enters them: a calendar date, a local start time and a title.
 *
 * The club is in one place, so the wall clock is the club's — America/New_York — whatever the
 * admin's browser or the server is set to. Everything that decides lives here as pure functions
 * over an injected `now`, so the refusals (blank date, blank time, a date already gone) are
 * tested without a request, and "today" can be pinned to either side of midnight in Ohio.
 *
 * The instant is resolved through Intl rather than a timezone library: the only zone Tender
 * needs is the one the club sits in, and Node carries the IANA data already.
 */

export const CLUB_TZ = "America/New_York";

export type RaceDateInput = { date: string; time: string; title: string };

export type Refusal =
  | "blank-date"
  | "blank-time"
  | "invalid-date"
  | "past-date"
  | "blank-title"
  | "title-too-long";

export type Parsed =
  | { ok: true; startsAt: Date; title: string }
  | { ok: false; reason: Refusal };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;
export const TITLE_MAX = 80;

/**
 * Decide whether the form is a race date. Blank date or time is refused outright — there is no
 * default start time to invent, because the ladder clock counts down to this instant and a
 * guessed one would open rungs at the wrong hour. A date earlier than today in the club's zone
 * is refused; today itself is allowed, since a race later this afternoon is still a race.
 */
export function parseRaceDateForm(input: RaceDateInput, now: Date): Parsed {
  const title = input.title.trim();
  const date = input.date.trim();
  const time = input.time.trim();

  if (!DATE.test(date)) return { ok: false, reason: "blank-date" };
  if (!TIME.test(time)) return { ok: false, reason: "blank-time" };
  if (title.length < 1) return { ok: false, reason: "blank-title" };
  if (title.length > TITLE_MAX) return { ok: false, reason: "title-too-long" };

  const [, hh, mm] = TIME.exec(time)!;
  if (Number(hh) > 23 || Number(mm) > 59) return { ok: false, reason: "blank-time" };

  const startsAt = zonedToUtc(date, time);
  // A calendar date that does not exist (2027-02-30) rolls over when resolved; catch it by
  // asking what wall date the instant actually landed on.
  if (localDate(startsAt) !== date) return { ok: false, reason: "invalid-date" };

  if (date < localDate(now)) return { ok: false, reason: "past-date" };

  return { ok: true, startsAt, title };
}

/** The club-zone wall clock at an instant, as numbers. */
function wallClock(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    h: get("hour"),
    min: get("minute"),
    s: get("second"),
  };
}

/** How far (ms) the club zone's wall clock is ahead of UTC at `instantMs` (negative in Ohio). */
function offsetAt(instantMs: number): number {
  const w = wallClock(new Date(instantMs));
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - instantMs;
}

/**
 * The instant at which the club zone's wall clock reads `date` `time`. Two passes: the offset is
 * read at the naive instant, then re-read at the corrected one, so a time on the day the clocks
 * change resolves with the offset in force at that time rather than at midnight UTC.
 */
export function zonedToUtc(date: string, time: string): Date {
  const [, y, mo, d] = DATE.exec(date)!;
  const [, h, mi] = TIME.exec(time)!;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const first = offsetAt(wall);
  let utc = wall - first;
  const second = offsetAt(utc);
  if (second !== first) utc = wall - second;
  return new Date(utc);
}

/** The calendar date (YYYY-MM-DD) in the club zone at an instant. */
export function localDate(instant: Date): string {
  const w = wallClock(instant);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** How a race date reads on the board: its local date and its local start time. */
export function formatStartsAt(iso: string): { date: string; time: string } {
  const instant = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("en-US", {
      timeZone: CLUB_TZ,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(instant),
    time: new Intl.DateTimeFormat("en-US", {
      timeZone: CLUB_TZ,
      hour: "numeric",
      minute: "2-digit",
    }).format(instant),
  };
}

/**
 * How a race start reads inside a sentence — "Sun, Jun 13, 1:00 PM" — for the notifications that
 * name it (story #23's email, story #29's push).
 *
 * It lives here rather than beside either sender because there is exactly one right answer to
 * "what time does this race start", and it is the club's wall clock. `src/notify/rung.ts` carried
 * its own `timeZone: "America/New_York"` literal until #29, which would have become the third
 * copy the moment push needed the same string — and a notification whose date disagrees with the
 * board's by an hour twice a year is the kind of defect nobody reproduces.
 */
export function whenLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CLUB_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The message the admin sees for a refusal. */
export function explainRefusal(reason: string): string {
  switch (reason) {
    case "blank-date":
      return "Enter the race date.";
    case "blank-time":
      return "Enter the start time — there is no default; the ladder counts down to it.";
    case "invalid-date":
      return "That date does not exist.";
    case "past-date":
      return "That date has already gone.";
    case "blank-title":
      return "Give the race day a title.";
    case "title-too-long":
      return `Keep the title to ${TITLE_MAX} characters.`;
    case "refused":
      return "The database refused that change. Only the club admin can edit race dates.";
    default:
      return "That could not be saved.";
  }
}
