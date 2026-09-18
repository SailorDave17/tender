/**
 * The season's crewing metric — the charter's success measure, as a pure function (story #38).
 *
 * The charter compares **matches ÷ race days elapsed** against a failure line of **1.0**: fewer
 * than one match per race day, averaged over the season, and the board is not doing the job the
 * club built it for. `src/push/install.ts` is the sibling of this file — same shape, same reason
 * for existing: a ratio computed inline on a page is a number nobody can test at the boundary,
 * and this one has a boundary that decides whether the whole product is working.
 *
 * ## Why "no race days yet" is a value and not a zero
 *
 * `installSummary()` answers an empty club with 0%, which is true — nobody has installed. The
 * same move here would be a lie of a different kind. Zero matches over zero race days is not a
 * ratio of zero; it is **no reading at all**, and a season that has not started would report
 * itself as failing the charter's line on the day it is created.
 *
 * That distinction is not this file being careful. It is the shape cairn recorded on Taskr #480
 * ([[a-per-element-rule-has-no-answer-for-the-empty-aggregate-2026-09-16]]): a rule written per
 * element ("each race day contributes one to the denominator") says nothing about what the whole
 * means when there are no elements, and the aggregate needs its own clause. Story #38 AC 3 wrote
 * that clause into the criterion, which is why this is a named case rather than a division.
 *
 * So `ratio` is `null` when nothing has elapsed, and every caller has to say what it renders for
 * that — the type makes the empty season unignorable rather than letting it round to 0.00.
 *
 * ## What counts on each side (owner decision, 2026-09-18)
 *
 * **Numerator: every match, whatever its status.** An `accepted` match the crew never confirmed
 * and a `no_show` both count. The metric measures *what the board produced* — a pairing that
 * existed — and deliberately not whether the boat left the dock. Counting only `sailed` was
 * considered and rejected at the gate: match statuses arrived with #37, so every race day before
 * that would contribute nothing to the numerator and one to the denominator, and the season-to-
 * date figure would read artificially low against a line it could then never reach.
 *
 * **Denominator: published race dates whose start has passed.** Unpublished dates were never on
 * the board, so no crew could answer a post on one; counting them would charge the metric for
 * days the club never ran. A future date has not elapsed and is not counted either — which is
 * what "elapsed" means, and is what keeps the figure from sagging every time the admin enters
 * next season's calendar.
 *
 * ## The anonymised match
 *
 * AC 3 asks that "an anonymised match still counts". A match row whose people are no longer
 * readable — a person deleted, or a contact row the viewer cannot see — is still a match that
 * happened, and the season's count is a count of *events*, not of names it can print. So this
 * file counts rows and never dereferences a person; the screen resolves names separately and
 * renders what it cannot resolve as "(removed)". A metric that silently dropped such a row would
 * under-report the club's real crewing, and would do it most in the seasons furthest past.
 */

/** A match, as the metric sees it: one row, no names. Status is carried but deliberately unused. */
export type MetricMatch = {
  id: string;
  /** The post the match is on, so a caller can attribute it to a race day. */
  post_id: string;
};

/** A race day, as the metric sees it. Only published dates should be passed in. */
export type MetricRaceDate = {
  id: string;
  starts_at: string | Date;
};

export type SeasonMetric = {
  /** Matches counted. Every status counts; see the header. */
  matches: number;
  /** Published race dates whose start has passed, at `now`. */
  raceDaysElapsed: number;
  /**
   * Matches per elapsed race day, to two decimal places — or **null when nothing has elapsed**,
   * which is "no race days yet" and is not the same claim as 0.00.
   */
  ratio: number | null;
  /**
   * Whether the charter's failure line is met: strictly below 1.0. **False when `ratio` is
   * null** — a season with no race days has not failed the line, it has not been measured.
   */
  belowLine: boolean;
};

/** The charter's failure line: fewer than one match per elapsed race day. */
export const FAILURE_LINE = 1.0;

/** What a caller renders when there is no reading. One spelling, so the pages cannot disagree. */
export const NO_READING = "no race days yet";

/**
 * Count elapsed race days. A date exactly at `now` has started, so it counts — the same
 * direction `on_race_day` and the ladder's clock take, where the start instant belongs to the
 * race rather than to the day before it.
 */
export function elapsedRaceDays(dates: readonly MetricRaceDate[], now: Date): number {
  return dates.filter((d) => new Date(d.starts_at).getTime() <= now.getTime()).length;
}

/**
 * The season's metric over every match and every published race date.
 *
 * `matches` is a plain row count and is never filtered by status — see the header. Rounding is
 * to two decimals by `Math.round`, so 0.695 reads 0.70 and 0.694 reads 0.69. Unlike
 * `installSummary`'s deliberate floor, there is no safe direction here: the figure is reported to
 * a person, and the kill decision is `belowLine`, which is computed on the **unrounded** ratio so
 * a season at 0.999 is below the line however it prints.
 */
export function seasonMetric(
  matches: readonly MetricMatch[],
  dates: readonly MetricRaceDate[],
  now: Date,
): SeasonMetric {
  const raceDaysElapsed = elapsedRaceDays(dates, now);
  if (raceDaysElapsed === 0) {
    // No reading. Not zero, and explicitly not "below the line" — see the header.
    return { matches: matches.length, raceDaysElapsed: 0, ratio: null, belowLine: false };
  }
  const exact = matches.length / raceDaysElapsed;
  return {
    matches: matches.length,
    raceDaysElapsed,
    ratio: Math.round(exact * 100) / 100,
    // Read off the unrounded value on purpose: 0.996 prints 1.00 and is still below the line.
    belowLine: exact < FAILURE_LINE,
  };
}

/** The metric as the pages print it: "0.70", or "no race days yet". One spelling for both. */
export function formatRatio(metric: SeasonMetric): string {
  return metric.ratio === null ? NO_READING : metric.ratio.toFixed(2);
}
