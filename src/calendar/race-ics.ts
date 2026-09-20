/**
 * raceIcs(): the race a match is for, as an iCalendar file (story #34, AC 1).
 *
 * One VCALENDAR holding one VEVENT, written to RFC 5545 by hand rather than through a library:
 * the whole format this needs is seven properties, and the three rules that make it valid are
 * stated and tested here — CRLF line endings, TEXT escaping, and folding at 75 OCTETS (UTF-8
 * bytes, not characters, and never inside a character). The test parses the output back with an
 * independent parser (ical.js) so the file is checked by something that did not write it.
 *
 *   UID          <match id>@tender.madcowsailing.com — one match, one event, so a second download
 *                of the same file updates the calendar entry rather than duplicating it.
 *   DTSTAMP      the match's accepted_at. Required by RFC 5545; taken from the match rather than
 *                the clock so the function stays pure and the file is byte-stable per match.
 *   DTSTART      race_date.starts_at in UTC ("Z" form). The club's wall clock is America/New_York
 *                (src/dates/race-date.ts), but a UTC instant needs no VTIMEZONE block and every
 *                calendar shows it in the reader's own zone.
 *   DURATION     PT3H — three hours, the filed figure; a race day has no recorded end time.
 *   SUMMARY      "<boat class> with <skipper name> — <club name>".
 *   DESCRIPTION  the post's note, then the match URL. An empty note leaves the URL alone.
 *
 * It THROWS on input it cannot render (an unparseable start, a blank name): the email path
 * catches that and sends without the attachment (AC 3), and the download route answers 500.
 * A file with a wrong or empty field would be worse than none, because nothing would say so.
 */

export type IcsMatch = {
  id: string;
  /** match.accepted_at, ISO — the DTSTAMP. */
  acceptedAt: string;
  skipperName: string;
  /** Where the match is viewed, absolute. The post page, where MatchPanel shows both parties. */
  url: string;
};
export type IcsPost = { boatClass: string; note: string };
export type IcsRaceDate = { startsAt: string };
export type IcsClub = { name: string };

export const ICS_DOMAIN = "tender.madcowsailing.com";
export const ICS_DURATION = "PT3H";
export const ICS_FILENAME = "race.ics";
/** The MIME type the attachment and the download route both carry. UTF-8, for the em-dash. */
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";
export const PRODID = "-//Tender//Crew board//EN";

const CRLF = "\r\n";
const MAX_OCTETS = 75;

export function raceIcs(match: IcsMatch, post: IcsPost, raceDate: IcsRaceDate, club: IcsClub): string {
  const start = utcStamp(raceDate.startsAt, "race_date.starts_at");
  const stamp = utcStamp(match.acceptedAt, "match.accepted_at");
  const boatClass = required(post.boatClass, "boat class");
  const skipper = required(match.skipperName, "skipper name");
  const clubName = required(club.name, "club name");
  const url = required(match.url, "match url");
  const note = post.note.trim();

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${required(match.id, "match id")}@${ICS_DOMAIN}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DURATION:${ICS_DURATION}`,
    `SUMMARY:${escapeText(`${boatClass} with ${skipper} — ${clubName}`)}`,
    `DESCRIPTION:${escapeText(note ? `${note}\n\n${url}` : url)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join(CRLF) + CRLF;
}

/** An ISO instant as a UTC DATE-TIME: 20270613T170000Z. Throws on anything Date cannot read. */
export function utcStamp(iso: string, what: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) throw new Error(`ics: ${what} is not a date: ${JSON.stringify(iso)}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * RFC 5545 §3.3.11 TEXT: backslash, semicolon and comma are escaped, a line break becomes the two
 * characters `\n`. Other control characters are not allowed in TEXT at all and are dropped —
 * a note is typed by a person and could carry a stray one. Kept: TAB (0x09), which TEXT allows,
 * and LF (0x0a), which the last replace turns into the escape.
 */
export function escapeText(s: string): string {
  const printable = Array.from(s.replace(/\r\n|\r|\n/g, "\n"))
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c === 0x09 || c === 0x0a || (c >= 0x20 && c !== 0x7f);
    })
    .join("");
  return printable
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * RFC 5545 §3.1: a content line longer than 75 octets is split, each continuation starting with
 * one space — and the space counts toward that line's 75. Splits fall between characters, never
 * inside a multi-byte UTF-8 sequence, so a line may end a byte or two short of the limit.
 */
export function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (octets + size > MAX_OCTETS) {
      out.push(current);
      current = " ";
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join(CRLF);
}

function required(value: string, what: string): string {
  if (!value || !value.trim()) throw new Error(`ics: ${what} is blank`);
  return value.trim();
}
