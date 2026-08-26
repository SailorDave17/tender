/**
 * The ladder — Tender's matching engine, as a pure function.
 *
 * A skipper posts a need against a race date with a boat class and the minimum competence they
 * will take. Every crew sits on a rung relative to that post:
 *
 *   rung 1 (strict): hull willingness includes the class AND rating >= minimum
 *   rung 2 (amber):  any hull,                              rating >= minimum
 *   rung 3 (red):    rating < minimum
 *
 * The post itself has an OPEN rung: the engine proposes every available crew on or above it.
 * It steps the open rung down on EMPTINESS or on the CLOCK, whichever comes first (charter,
 * owner decision 2026-08-21): rung 2 no later than 48 h before the race, rung 3 no later than
 * 24 h before. The ladder colours and orders; it never hides anyone — a red suggestion is still
 * a suggestion, and a rung-1 crew is never dropped because the post has widened.
 *
 * Pure: (post, pool, now) -> open rung + candidates, each carrying their own rung. No I/O, no
 * clock of its own. The scaffold's one real test lives beside this file and is mutation-proven
 * (docs/adr/006-testing-strategy.md).
 */

// 1 never raced, 2 can hike and trim, 3 can fly a spinnaker, 4 can helm (0011, story #69).
export type Competence = 1 | 2 | 3 | 4;
// The LADDER's scale — strict, amber, red. Unrelated to Competence, and deliberately still three.
export type Rung = 1 | 2 | 3;

export interface Crew {
  id: string;
  rating: Competence;
  /** Boat classes this person is willing to sail; empty means "any hull". */
  hulls: readonly string[];
  /** True when the person has marked the post's race date as available. */
  available: boolean;
}

export interface Post {
  raceAt: Date;
  boatClass: string;
  minimum: Competence;
}

export interface Candidate {
  crew: Crew;
  rung: Rung;
}

export interface Suggestion {
  /** The rung the post is open to after emptiness and clock are applied. */
  rung: Rung;
  /** Available crew on or above the open rung, best rung first. */
  candidates: Candidate[];
}

export const RUNG_2_BEFORE_MS = 48 * 60 * 60 * 1000;
export const RUNG_3_BEFORE_MS = 24 * 60 * 60 * 1000;

function willingOnHull(crew: Crew, boatClass: string): boolean {
  return crew.hulls.length === 0 || crew.hulls.includes(boatClass);
}

/** The rung a crew sits on for this post, regardless of availability. */
export function rungOf(post: Post, crew: Crew): Rung {
  if (crew.rating < post.minimum) return 3;
  return willingOnHull(crew, post.boatClass) ? 1 : 2;
}

/** The lowest rung the clock alone has opened. */
export function rungOpenedByClock(post: Post, now: Date): Rung {
  const untilRace = post.raceAt.getTime() - now.getTime();
  if (untilRace <= RUNG_3_BEFORE_MS) return 3;
  if (untilRace <= RUNG_2_BEFORE_MS) return 2;
  return 1;
}

/**
 * Propose crew for a post. Opens at the rung the clock allows, then widens while no available
 * crew sits on or above the open rung. Rung 3 is the floor: it returns whatever it has,
 * possibly nobody.
 */
export function suggest(post: Post, pool: readonly Crew[], now: Date): Suggestion {
  const tagged = pool
    .filter((crew) => crew.available)
    .map((crew) => ({ crew, rung: rungOf(post, crew) }))
    .sort((a, b) => a.rung - b.rung);

  let open = rungOpenedByClock(post, now);
  for (;;) {
    const candidates = tagged.filter((c) => c.rung <= open);
    if (candidates.length > 0 || open === 3) return { rung: open, candidates };
    open = (open + 1) as Rung;
  }
}
