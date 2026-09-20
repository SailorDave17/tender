import { CLUB_TZ, TITLE_MAX, zonedToUtc, localDate } from "./race-date";

/**
 * parseRaceIcs(): the club's season calendar, read out of an uploaded .ics (story #40, AC 1).
 *
 * A pure function over the file's text: it returns the race days it could read, in the order the
 * file lists them, and a list of what it could not read, each naming the line it gave up on.
 * Nothing here throws on the file's content — a bad calendar is an ordinary input and the admin
 * is shown what was wrong with it, per line, on the review screen. It writes nothing; the
 * publish step is a separate action that runs only after the admin has ticked the rows.
 *
 * Read by hand rather than through a library, like `src/calendar/race-ics.ts` writes by hand:
 * the subset that matters is DTSTART, SUMMARY and RRULE inside VEVENT, plus the three format
 * rules any reader has to honour — CRLF or LF line endings, unfolding of continuation lines, and
 * TEXT unescaping. A hand reader can also say *which line* it stopped on, which a library's
 * parse tree cannot.
 *
 * ## How a DTSTART becomes an instant
 *
 *   20270411T170000Z                    UTC — the instant as written.
 *   DTSTART;TZID=America/New_York:…     the wall clock in that zone, resolved through Intl by
 *                                       the same two-pass rule the hand form uses (zonedToUtc).
 *                                       Any zone Intl knows is accepted; an unknown one is a
 *                                       problem by line, not a guess.
 *   20270411T130000  (floating)         RFC 5545 says "local time" with no zone. The club sits
 *                                       in one place, so floating means America/New_York — the
 *                                       one assumption this file makes, stated here and tested
 *                                       across both DST boundaries.
 *   DTSTART;VALUE=DATE:20270411         an all-day event has no start time, and a race day
 *                                       without one has no meaning to the ladder clock (0004's
 *                                       header). Reported by line rather than defaulted, for
 *                                       the same reason the hand form refuses a blank time.
 *
 * ## RRULE
 *
 * A recurring event is returned with the FIRST occurrence's instant and flagged `unsupported`,
 * never expanded. Expanding an RRULE correctly (BYDAY, COUNT, UNTIL, EXDATE, DST across the
 * series) is a library's worth of work for a club that races ~20 fixed dates a season; the
 * review screen shows the row highlighted and refuses to tick it, and the admin enters the
 * series by hand or exports it expanded. RDATE is treated the same way — it is a second date
 * on one event, and one row cannot carry two.
 */

export type IcsRow = {
  /** The instant, ISO 8601 in UTC — the shape `race_date.starts_at` takes. */
  startsAt: string;
  title: string;
  /** The physical line the VEVENT began on, for the review screen and for problems. */
  line: number;
  /** Set when the row cannot be published as it stands; the review screen highlights it. */
  unsupported?: "rrule";
};

export type IcsProblem = { line: number; message: string };

export type IcsParse = { rows: IcsRow[]; problems: IcsProblem[] };

type Property = { name: string; params: Map<string, string>; value: string; line: number };

/** RFC 5545 §3.3.5 DATE-TIME: 20270411T170000 with an optional trailing Z. */
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

export function parseRaceIcs(text: string): IcsParse {
  const rows: IcsRow[] = [];
  const problems: IcsProblem[] = [];

  // Component nesting, by name. A VEVENT's properties are read only while VEVENT is the innermost
  // open component — a VALARM inside it carries no DTSTART but may carry a SUMMARY, and reading
  // that would retitle the race after the alarm.
  const stack: string[] = [];
  let event: { line: number; props: Property[] } | null = null;

  for (const prop of contentLines(text)) {
    if (prop.name === "BEGIN") {
      const component = prop.value.toUpperCase();
      stack.push(component);
      if (component === "VEVENT" && stack.length && event === null) event = { line: prop.line, props: [] };
      continue;
    }
    if (prop.name === "END") {
      const component = prop.value.toUpperCase();
      // Pop back to the matching BEGIN; a stray END is ignored rather than fatal.
      const at = stack.lastIndexOf(component);
      if (at >= 0) stack.length = at;
      if (component === "VEVENT" && event) {
        finish(event, rows, problems);
        event = null;
      }
      continue;
    }
    if (event && stack[stack.length - 1] === "VEVENT") event.props.push(prop);
  }
  // A VEVENT the file never closed is reported, not silently dropped.
  if (event) problems.push({ line: event.line, message: "VEVENT is never closed (no END:VEVENT)" });

  return { rows, problems };
}

function finish(event: { line: number; props: Property[] }, rows: IcsRow[], problems: IcsProblem[]) {
  const first = (name: string) => event.props.find((p) => p.name === name);
  const dtstart = first("DTSTART");
  const summary = first("SUMMARY");

  const title = summary ? unescapeText(summary.value).replace(/\s+/g, " ").trim() : "";
  let ok = true;
  if (!dtstart) {
    problems.push({ line: event.line, message: "VEVENT has no DTSTART" });
    ok = false;
  }
  if (!title) {
    problems.push({ line: summary?.line ?? event.line, message: "VEVENT has no SUMMARY to use as the title" });
    ok = false;
  } else if (title.length > TITLE_MAX) {
    problems.push({ line: summary!.line, message: `SUMMARY is longer than ${TITLE_MAX} characters` });
    ok = false;
  }
  if (!dtstart || !ok) return;

  const start = resolveStart(dtstart);
  if (!start.ok) {
    problems.push({ line: dtstart.line, message: start.message });
    return;
  }

  const row: IcsRow = { startsAt: start.instant.toISOString(), title, line: event.line };
  if (first("RRULE") || first("RDATE")) row.unsupported = "rrule";
  rows.push(row);
}

type Resolved = { ok: true; instant: Date } | { ok: false; message: string };

/** One DTSTART property to an instant, or the sentence the review screen shows for it. */
export function resolveStart(prop: Property): Resolved {
  if (prop.params.get("VALUE")?.toUpperCase() === "DATE") {
    return { ok: false, message: "DTSTART is an all-day date with no start time; a race day needs one" };
  }
  const m = DATE_TIME.exec(prop.value.trim());
  if (!m) return { ok: false, message: `DTSTART is not a date-time: ${JSON.stringify(prop.value)}` };
  const [, y, mo, d, h, mi, s, z] = m;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) {
    return { ok: false, message: `DTSTART has an impossible time of day: ${prop.value}` };
  }

  if (z === "Z") {
    const instant = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    if (localDate(instant, "UTC") !== `${y}-${mo}-${d}`) {
      return { ok: false, message: `DTSTART names a day that does not exist: ${prop.value}` };
    }
    return { ok: true, instant };
  }

  // A zoned or floating time is a wall clock: a floating one is read in the club's zone.
  const zone = prop.params.get("TZID") ?? CLUB_TZ;
  const date = `${y}-${mo}-${d}`;
  let instant: Date;
  try {
    instant = zonedToUtc(date, `${h}:${mi}`, zone);
  } catch {
    return { ok: false, message: `DTSTART names a time zone this club cannot read: ${zone}` };
  }
  // 2027-02-30 rolls over when resolved; ask what wall date the instant landed on (as the hand
  // form does) rather than trusting the arithmetic.
  if (localDate(instant, zone) !== date) {
    return { ok: false, message: `DTSTART names a day that does not exist: ${prop.value}` };
  }
  return { ok: true, instant: new Date(instant.getTime() + Number(s) * 1000) };
}

/**
 * The file as content lines: CRLF or LF endings, continuation lines (RFC 5545 §3.1: a line
 * beginning with a space or tab) folded back onto the line above, each carrying the physical
 * line number it began on. Blank lines are skipped; a line with no colon is not a content line
 * and is skipped too — a reader that threw on one would fail the whole file for a stray byte.
 */
export function contentLines(text: string): Property[] {
  const physical = text.split(/\r\n|\n|\r/);
  const logical: { text: string; line: number }[] = [];
  physical.forEach((raw, i) => {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && logical.length) {
      logical[logical.length - 1].text += raw.slice(1);
    } else if (raw.length) {
      logical.push({ text: raw, line: i + 1 });
    }
  });
  const out: Property[] = [];
  for (const { text: line, line: n } of logical) {
    const parsed = splitContentLine(line);
    if (parsed) out.push({ ...parsed, line: n });
  }
  return out;
}

/**
 * NAME;PARAM=VALUE;PARAM="quoted:value":VALUE — the name and parameters end at the first colon
 * outside double quotes, so a quoted TZID carrying a colon does not truncate the parameter list.
 */
function splitContentLine(line: string): Omit<Property, "line"> | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitOutsideQuotes(head, ";");
  const name = parts[0].trim().toUpperCase();
  if (!name) return null;
  const params = new Map<string, string>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params.set(p.slice(0, eq).trim().toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return { name, params, value };
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let current = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** RFC 5545 §3.3.11 TEXT, the inverse of race-ics.ts's escapeText: \n, \, \; and \\ read back. */
export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ---------------------------------------------------------------------------------------------
// Publishing (AC 3): which of the ticked rows are new, and which the calendar already holds.
// ---------------------------------------------------------------------------------------------

export type ExistingDate = { starts_at: string; title: string };
export type PublishRow = { startsAt: string; title: string };

export type ImportPlan = { insert: PublishRow[]; duplicates: PublishRow[] };

/**
 * A row is a duplicate when the calendar already has a race at the same instant with the same
 * title — matched on the instant (so `+00:00` and `Z` spellings agree) and the trimmed title,
 * exactly as the AC states. Duplicates within the ticked set itself collapse too, so a file that
 * lists the same race twice inserts it once. Existing rows count whether or not they are
 * published: an unpublished duplicate is still that race, and the admin publishes it from
 * /admin/dates rather than by importing a second copy.
 */
export function planImport(selected: readonly PublishRow[], existing: readonly ExistingDate[]): ImportPlan {
  const key = (startsAt: string, title: string) => `${new Date(startsAt).getTime()}|${title.trim()}`;
  const seen = new Set(existing.map((e) => key(e.starts_at, e.title)));
  const plan: ImportPlan = { insert: [], duplicates: [] };
  for (const row of selected) {
    const k = key(row.startsAt, row.title);
    if (seen.has(k)) {
      plan.duplicates.push(row);
    } else {
      seen.add(k);
      plan.insert.push(row);
    }
  }
  return plan;
}

/**
 * A ticked row as it comes back from the review form: the JSON the checkbox carried. Anything
 * that is not a plausible row is refused — the form is the admin's, but a Server Action is a
 * POST anyone can craft, and the database's insert must only ever see an instant and a title.
 */
export function readPublishRow(value: unknown): PublishRow | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { startsAt, title } = parsed as Record<string, unknown>;
  if (typeof startsAt !== "string" || typeof title !== "string") return null;
  const t = new Date(startsAt).getTime();
  if (Number.isNaN(t)) return null;
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > TITLE_MAX) return null;
  return { startsAt: new Date(t).toISOString(), title: trimmed };
}
