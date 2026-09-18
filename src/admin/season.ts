import type { MatchStatus } from "@/post/match-view";

/**
 * What the admin's two screens say about a season and about one race day (story #38).
 *
 * Pure over an injected `now`, like every view-model in this repo, so the boundary cases — a
 * race day that has just started, a post that never found crew — are unit tested against a fixed
 * clock and the pages only call this. The season's ratio itself lives in `src/lib/metric.ts`;
 * this file is the per-day half and the row model the detail screen renders.
 *
 * ## The rung shown here is the STORED rung, and that is a deliberate departure
 *
 * `src/board/post-view.ts` shows `max(stored, computed)`, because the board is answering "who can
 * I reach *now*" and the clock half (48 h / 24 h) is not persisted. This screen is answering a
 * different question — "what happened" — and the same call would be actively misleading on it.
 *
 * `rungOpenedByClock` reads `raceAt - now`, which is **negative for every past race**, so it
 * returns rung 3 for every post of every race day that has been sailed. An admin's history
 * column built on `openRungOf` would print "3" against all of it and carry no information at all,
 * while looking exactly like a measurement.
 *
 * `post.current_rung` (0010) is the honest record: written by `notifyRung()` when a post opens or
 * a crew marks the day, monotone by a trigger that refuses any decrease, and therefore **the
 * widest rung the ladder actually opened and emailed**. That is what "final rung" in AC 1 names.
 *
 * ## Unmatched is tested on the match, never on `closed_at`
 *
 * `accept_answer()` (0008) sets `closed_at = coalesce(closed_at, now())`, so a matched post is
 * closed — but a skipper may also close a post by hand with nobody on it. Reading `closed_at` as
 * "matched" would count those as crewed and silently under-report the one number the charter
 * cares about, "boats that did not sail for want of crew". So the predicate is the absence of a
 * match row, and `closed_at` is carried only to explain *why* a post is open.
 */

/** A post, as the admin's screens read it. Column names are `post`'s own (0006, 0010). */
export type SeasonPost = {
  id: string;
  boat_id: string;
  race_date_id: string;
  minimum: 1 | 2 | 3 | 4;
  closed_at: string | null;
  /** 0010: the widest rung ever opened and notified. The history column — see the header. */
  current_rung: 1 | 2 | 3;
};

export type SeasonMatchRow = {
  id: string;
  post_id: string;
  skipper_id: string;
  crew_id: string;
  status: MatchStatus;
};

export type SeasonBoat = { id: string; owner_id: string; name: string; class: string };
export type SeasonPerson = { id: string; display_name: string };
export type SeasonDate = { id: string; starts_at: string; title: string; published: boolean };

/** What the detail screen prints per post. Every name is already resolved, or null. */
export type RaceDayPostRow = {
  postId: string;
  boatName: string;
  boatClass: string;
  minimum: 1 | 2 | 3 | 4;
  /** post.current_rung — the widest rung the ladder opened. See the header. */
  finalRung: 1 | 2 | 3;
  /** Null when the boat's owner is no longer readable; the screen prints "(removed)". */
  skipper: string | null;
  /**
   * The matched crew's name, null when the person is unreadable but a match exists, and the
   * whole `match` being null is what "open" means on the screen. The two nulls are different
   * claims and the screen must not collapse them — an anonymised match is still a match
   * (story #38 AC 3), and printing it as "open" would erase a boat that did sail.
   */
  crew: string | null;
  /** Null when there is no match at all — the post never found crew. */
  status: MatchStatus | null;
  /** True when no match row exists for this post. */
  open: boolean;
};

/** The per-date counts the season screen prints beside each race day. */
export type RaceDayCounts = {
  dateId: string;
  posts: number;
  matched: number;
  sailed: number;
  noShow: number;
  /**
   * Posts with no match. **Only meaningful once the day has started** — before that it is the
   * count of boats still looking, which is a different claim in the same shape. `elapsed` is what
   * tells the screen which sentence to print (owner decision 2026-09-18: future days show the
   * figure, labelled as provisional).
   */
  unmatched: number;
  /** Whether this race day's start has passed at `now`. */
  elapsed: boolean;
};

function startedBy(date: SeasonDate, now: Date): boolean {
  // A date exactly at `now` has started — the same direction the ladder's clock takes.
  return new Date(date.starts_at).getTime() <= now.getTime();
}

/**
 * Counts per race day, in the order the dates were handed in.
 *
 * `matched` counts every match whatever its status, so it agrees with the season metric's
 * numerator; `sailed` and `noShow` are subsets of it and deliberately do not sum to it — a match
 * still `accepted` or `confirmed` on a day already sailed is neither, which is itself worth
 * seeing on the screen.
 */
export function countsByDate(
  dates: readonly SeasonDate[],
  posts: readonly SeasonPost[],
  matches: readonly SeasonMatchRow[],
  now: Date,
): RaceDayCounts[] {
  const matchByPost = new Map(matches.map((m) => [m.post_id, m]));
  return dates.map((d) => {
    const forDate = posts.filter((p) => p.race_date_id === d.id);
    const withMatch = forDate.map((p) => matchByPost.get(p.id)).filter((m) => m !== undefined);
    return {
      dateId: d.id,
      posts: forDate.length,
      matched: withMatch.length,
      sailed: withMatch.filter((m) => m.status === "sailed").length,
      noShow: withMatch.filter((m) => m.status === "no_show").length,
      unmatched: forDate.length - withMatch.length,
      elapsed: startedBy(d, now),
    };
  });
}

/**
 * The charter's headline: boats that did not sail for want of crew, across the season.
 *
 * Counted **only over race days that have started**, because the phrase is past tense and a post
 * on next Saturday has not failed to find crew — it is still looking. Summing every unmatched
 * post whatever the date would report a club that has just published its calendar as having
 * stranded a boat for every post on it.
 */
export function boatsWithoutCrew(counts: readonly RaceDayCounts[]): number {
  return counts.filter((c) => c.elapsed).reduce((n, c) => n + c.unmatched, 0);
}

/**
 * Every post for one race day, as the detail screen prints them — boats first by name so the
 * order is stable across reloads and does not move as matches are made.
 *
 * A person who cannot be resolved comes back as null rather than being dropped. The screen owes
 * the admin a row per post whatever it can name: a post whose skipper left the club is still a
 * boat that was on the water, and a match whose crew is gone is still a match (AC 3's
 * "an anonymised match still counts", in the shape the screen meets it).
 */
export function raceDayRows(
  dateId: string,
  posts: readonly SeasonPost[],
  matches: readonly SeasonMatchRow[],
  boats: ReadonlyMap<string, SeasonBoat>,
  people: ReadonlyMap<string, SeasonPerson>,
): RaceDayPostRow[] {
  const matchByPost = new Map(matches.map((m) => [m.post_id, m]));
  return posts
    .filter((p) => p.race_date_id === dateId)
    .map((p) => {
      const boat = boats.get(p.boat_id);
      const match = matchByPost.get(p.id);
      return {
        postId: p.id,
        boatName: boat?.name ?? "(removed)",
        boatClass: boat?.class ?? "(removed)",
        minimum: p.minimum,
        finalRung: p.current_rung,
        skipper: boat ? (people.get(boat.owner_id)?.display_name ?? null) : null,
        crew: match ? (people.get(match.crew_id)?.display_name ?? null) : null,
        status: match?.status ?? null,
        open: match === undefined,
      };
    })
    .sort((a, b) => a.boatName.localeCompare(b.boatName) || a.postId.localeCompare(b.postId));
}
