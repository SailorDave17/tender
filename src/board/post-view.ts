import { rungOf, rungOpenedByClock, suggest, type Crew, type Post, type Rung } from "@/engine/ladder";
import { toCrew, type PersonRow } from "@/engine/toCrew";

/**
 * What the board and a post's page say about a post: its open rung and who is on it. Pure,
 * over an injected `now`, so the clock cases in story #19 AC 4 are unit-tested with a fixed
 * clock and the pages only call this.
 *
 * THE RUNG SHOWN IS max(STORED, COMPUTED). Until #23 the rung was computed on every read —
 * ADR 004's lazy-relaxation fallback shipped first — and could move in either direction
 * between two reads. Since 0010 a post carries current_rung, written by notifyRung() when a
 * post opens or a crew marks the day, and refused any decrease by a trigger: a rung that was
 * emailed stays open. A read still runs suggest(), because the clock half (48 h / 24 h) is not
 * persisted until #25/#26 schedule it — so the board can show a rung WIDER than the stored one
 * when the clock has passed, and never a narrower one (story #23 AC 4).
 */

/** The three rungs as the board colours them. The number is always in text beside the colour. */
export const RUNG_COLOUR: Record<Rung, { name: "green" | "amber" | "red"; hex: string }> = {
  1: { name: "green", hex: "#1E5443" },
  2: { name: "amber", hex: "#8A5A00" },
  3: { name: "red", hex: "#B42318" },
};

export type PostInput = {
  /** The race date's start, ISO or Date. */
  starts_at: string | Date;
  /** The boat's class. */
  boatClass: string;
  minimum: 1 | 2 | 3;
  /** post.current_rung (0010): the widest rung ever opened and notified. */
  current_rung: Rung;
};

export type PostView = {
  rung: Rung;
  colour: (typeof RUNG_COLOUR)[Rung];
  /** How many available crew sit on or above the open rung. */
  candidateCount: number;
  /** The rung the clock alone has opened — so a reader can tell clock from emptiness. */
  clockRung: Rung;
};

function toPost(p: PostInput): Post {
  return { raceAt: new Date(p.starts_at), boatClass: p.boatClass, minimum: p.minimum };
}

/** The people available for a date, as the engine sees them. Unrated rows are not crew. */
export function poolForDate(
  people: readonly PersonRow[],
  availability: readonly { person_id: string; race_date_id: string }[],
  raceDateId: string,
): Crew[] {
  const available = new Set(availability.filter((a) => a.race_date_id === raceDateId).map((a) => a.person_id));
  const pool: Crew[] = [];
  for (const row of people) {
    if (!available.has(row.id)) continue;
    const crew = toCrew(row, true);
    if (crew) pool.push(crew);
  }
  return pool;
}

/** The rung a post is open to now: the stored rung, or wider if suggest() widened it on this read. */
export function openRungOf(post: PostInput, pool: readonly Crew[], now: Date): Rung {
  const computed = suggest(toPost(post), pool, now).rung;
  return post.current_rung > computed ? post.current_rung : computed;
}

export function viewPost(post: PostInput, pool: readonly Crew[], now: Date): PostView {
  const p = toPost(post);
  const rung = openRungOf(post, pool, now);
  return {
    rung,
    colour: RUNG_COLOUR[rung],
    candidateCount: pool.filter((c) => c.available && rungOf(p, c) <= rung).length,
    clockRung: rungOpenedByClock(p, now),
  };
}

export type CandidateRow = {
  id: string;
  rung: Rung;
  colour: (typeof RUNG_COLOUR)[Rung];
  /** False when the crew's rung is below the post's open rung — the ladder has not reached them. */
  notified: boolean;
  /** The crew has an un-withdrawn answer on this post (story #20 AC 4). */
  answered: boolean;
};

const NOBODY: ReadonlySet<string> = new Set();

/**
 * Who the skipper sees for their post: everyone who answered, first, then every other available
 * crew for the date, best rung first within each group (story #19 AC 5, owner decision B; story
 * #20 AC 4). Stable within a rung: the order the pool came in.
 *
 * An answerer is listed whether or not they are still available — they said they can, and the
 * skipper should see it — so the pool handed in may carry answerers with `available: false`
 * (the page builds it that way). An answerer is never 'not yet notified': they answered.
 */
export function candidateRows(
  post: PostInput,
  pool: readonly Crew[],
  now: Date,
  answered: ReadonlySet<string> = NOBODY,
): CandidateRow[] {
  const p = toPost(post);
  const open = openRungOf(post, pool, now);
  return pool
    .filter((c) => c.available || answered.has(c.id))
    .map((c) => ({ id: c.id, rung: rungOf(p, c), answered: answered.has(c.id) }))
    .sort((a, b) => Number(b.answered) - Number(a.answered) || a.rung - b.rung)
    .map((r) => ({ ...r, colour: RUNG_COLOUR[r.rung], notified: r.answered || r.rung <= open }));
}
