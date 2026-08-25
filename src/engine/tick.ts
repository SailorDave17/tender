import { openRung, type RungPost } from "@/notify/rung";
import { rungOf, suggest, type Crew, type Post, type Rung } from "./ladder";

/**
 * The ladder tick — the clock half of the engine, as one pass over the open posts (story #25).
 *
 * Until now a post's rung moved only when a person did something: a skipper posting a need or a
 * crew marking a day, each of which calls notifyRung() (story #23). The 48 h / 24 h step-down
 * was computed on every board READ and persisted nowhere (ADR 004's lazy fallback), so a post
 * nobody looked at never told its next rung anything. This is what runs on a schedule and closes
 * that gap; #26 wires the clocks (pg_cron every 15 minutes, Vercel's daily sweep) to the route
 * that calls it.
 *
 * WHY IT IS CLOCK-AGNOSTIC. `now` is an argument and the repo is an interface, so this function
 * has no opinion about who calls it or how often. That is ADR 004's kill condition made cheap:
 * if pg_cron had turned out to be unavailable on the Free plan, only the caller changes.
 *
 * CATCH-UP IS ONE PASS, NOT A LOOP, and that is a property of the engine rather than of this
 * file. `rungOpenedByClock()` answers from `now` — 3 at 24 h or less, 2 at 48 h or less — so a
 * tick that first runs at 20 h opens rung 3 directly and reaches rung 2 and rung 3 crew in the
 * same call (AC 3). A tick that stepped one rung per run would need to have run at 48 h to be
 * correct at 20 h, and Supabase Free pauses a project after 7 idle days, so the run that should
 * have happened is exactly the one that will not have.
 *
 * WHAT IT DOES NOT DO: send. Dispatch is the email story's, reused rather than rebuilt — the
 * route hands each post this pass newly reached to `dispatchPending()` (src/notify/rung.ts),
 * which owns the daily cap, the log and the retry semantics. Keeping the two apart is also what
 * makes this testable through a pglite adapter with real SQL: the ladder half needs a database,
 * the sending half needs a transport, and neither test has to fake the other.
 */

/**
 * A post the tick may act on. Deliberately the same shape as notifyRung's `RungPost`: the route
 * passes it straight to dispatch, so a second read of the same row would be a second chance for
 * the two halves to disagree about which post they are talking about.
 */
export type TickPost = RungPost;

/** A (person, rung) pair on a post — a row of `suggestion` (0010), as this pass reads and writes it. */
export type Suggested = { personId: string; rung: Rung };

export type NewSuggestion = { postId: string; personId: string; rung: Rung };

export interface TickRepo {
  /**
   * The posts this tick may act on: not closed, and whose race has not started.
   *
   * A MATCHED post is a closed post — `accept_answer()` (0008) writes the match and sets
   * `closed_at` in the same transaction — so one clause excludes both, and there is deliberately
   * no second `not exists (select 1 from match …)` beside it. A redundant clause would make the
   * two of them one guard with a spare: deleting either would redden nothing, and AC 7's
   * matched-post mutation would have measured a test that cannot fail (cairn:
   * prove-a-guard-test-can-fail, sixteenth outcome). `test/tick.test.ts` asserts the invariant
   * the single clause rests on — accepting an answer closes the post — so the day it stops being
   * true, something goes red here rather than in production.
   *
   * `now` is what makes the started-race half of that filter possible, and it is load-bearing:
   * without it the tick would go on re-evaluating every unfilled post of a finished season, and
   * a person who marked a past day (which 0005 refuses, but a service-role fixture does not)
   * would be emailed about a race that has already sailed.
   */
  openPosts(now: Date): Promise<TickPost[]>;
  /** Every rated person available for the date, as the engine sees them. */
  poolFor(raceDateId: string): Promise<Crew[]>;
  /** The suggestion rows already on the post, notified or not. */
  suggestionsFor(postId: string): Promise<Suggested[]>;
  /** Only ever called with a rung ABOVE the stored one; 0010's trigger refuses a decrease. */
  setRung(postId: string, rung: Rung): Promise<void>;
  /** Insert, ignoring pairs already present (0010's primary key). */
  insertSuggestions(rows: NewSuggestion[]): Promise<void>;
}

export type TickedPost = {
  post: TickPost;
  /** The rung the post is open to after this pass. */
  rung: Rung;
  /** Crew this pass proposed for the first time — who the dispatch will reach. */
  reached: Suggested[];
};

export type TickResult = {
  /** Open posts evaluated. Not "posts changed": a tick with nothing to do still reports its work. */
  posts: number;
  /** Suggestion rows this pass added, across every post. */
  newSuggestions: number;
  /** Per post, for the caller that dispatches. Only posts with a non-empty `reached` need sending. */
  ticked: TickedPost[];
};

function enginePostOf(post: TickPost): Post {
  return { raceAt: new Date(post.startsAt), boatClass: post.boatClass, minimum: post.minimum };
}

/**
 * Widen every open post the clock (or an emptied rung) has reached, and report the crew newly
 * proposed. Writes rungs and suggestion rows; sends nothing.
 */
export async function runTick(repo: TickRepo, now: Date): Promise<TickResult> {
  const posts = await repo.openPosts(now);
  const ticked: TickedPost[] = [];

  for (const post of posts) {
    const pool = await repo.poolFor(post.raceDateId);
    const enginePost = enginePostOf(post);

    // The open rung: the widest of what was already told and what the clock or an emptied rung
    // opens now. The max is what stops the tick narrowing a post — a rung-1 crew marking the day
    // after rung 2 was emailed makes suggest() answer 1 again, and rung 2 has already been told
    // "we need you". `setRung` is called only on a widening, so 0010's trigger is a backstop
    // rather than the mechanism.
    const computed = suggest(enginePost, pool, now).rung;
    const rung = openRung(post.currentRung, computed);
    if (rung > post.currentRung) await repo.setRung(post.id, rung);

    // Everyone available on or above the open rung, at their own rung, and which of them is new.
    //
    // Two things decide "new", and they are not redundant. This READ is what the result reports
    // and what the caller dispatches on; the primary key on (post_id, person_id) is what makes
    // the write safe when a post-create or an availability toggle lands between the two. A row
    // written in that window is counted here as new and inserted as a no-op, so the worst case
    // is a post dispatched with nothing pending — which sends nothing.
    const already = new Set((await repo.suggestionsFor(post.id)).map((s) => s.personId));
    const candidates = pool
      .filter((crew) => crew.available)
      .map((crew) => ({ personId: crew.id, rung: rungOf(enginePost, crew) }))
      .filter((c) => c.rung <= rung);
    const reached = candidates.filter((c) => !already.has(c.personId));
    if (candidates.length > 0) {
      await repo.insertSuggestions(candidates.map((c) => ({ postId: post.id, ...c })));
    }

    ticked.push({ post, rung, reached });
  }

  return {
    posts: posts.length,
    newSuggestions: ticked.reduce((n, t) => n + t.reached.length, 0),
    ticked,
  };
}

/**
 * What /admin prints for the ladder clock (AC 5).
 *
 * Minutes, all the way up, on purpose. A tick that last ran 1440 minutes ago is a tick that has
 * been dead for a day, and the number that says so in the vocabulary the healthy case uses —
 * where #26 schedules it every 15 minutes — is louder than a tidy "1 day ago". The unit never
 * changes, so the reader never has to notice that it did.
 *
 * A clock running backwards (the server's, against a `last_at` written by Postgres) reads as
 * "just now" rather than a negative count.
 */
export function lastTickLabel(lastAt: Date | null, now: Date): string {
  if (lastAt === null) return "never";
  const minutes = Math.floor((now.getTime() - lastAt.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  return `${minutes} min ago`;
}
