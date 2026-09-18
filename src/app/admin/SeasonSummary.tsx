import type { RaceDayCounts, SeasonDate } from "@/admin/season";
import { formatRatio, type SeasonMetric } from "@/lib/metric";
import { formatStartsAt } from "@/dates/race-date";

/**
 * The season's crewing, as /admin prints it (story #38 AC 2): the charter's two headline numbers,
 * then a row per race day linking to its detail screen.
 *
 * Split out of the page so every reading can be rendered in a test with the figures handed in —
 * including the two that only occur on days nobody is watching: a season with no elapsed race
 * day, and a race day still to come. The page itself is an async Server Component that reads the
 * session and the database.
 *
 * ## The two headline numbers say different things and are not interchangeable
 *
 * **Boats that did not sail for want of crew** is a count of failures, over elapsed days only.
 * **Matches ÷ race days elapsed** is the charter's success metric against a failure line of 1.0.
 * A season can carry stranded boats and still clear the line (a day where two boats filled and
 * one did not), which is why both are printed rather than one derived from the other.
 *
 * ## A future race day's unmatched count is labelled, not hidden (owner decision 2026-09-18)
 *
 * The header's phrase is past tense — a post on next Saturday has not failed to find crew, it is
 * still looking. So the season total counts elapsed days only, while each future row still shows
 * its open posts as **still looking**, in its own wording. The alternative considered was showing
 * nothing for a future date; the admin wants the early warning, and the cost of giving it is that
 * the same figure must never be printed in the same words as the past-tense one.
 */
export function SeasonSummary({
  dates,
  counts,
  metric,
  strandedBoats,
}: {
  dates: readonly SeasonDate[];
  counts: readonly RaceDayCounts[];
  metric: SeasonMetric;
  strandedBoats: number;
}) {
  const byDate = new Map(counts.map((c) => [c.dateId, c]));

  return (
    <>
      {/* The past-tense sentence is only true once a race day has been sailed. Printed over an
          unstarted season it reads "0 boats did not sail for want of crew", which sounds like a
          clean record and is actually no record at all — the same mistake in prose that 0.00
          would be in the figure. */}
      {metric.raceDaysElapsed === 0 ? (
        <p data-not-started>
          No race day has been sailed yet, so there is nothing to count.{" "}
          <strong data-stranded-boats={strandedBoats}>{strandedBoats}</strong> boats stranded so
          far.
        </p>
      ) : (
        <p>
          <strong data-stranded-boats={strandedBoats}>{strandedBoats}</strong>{" "}
          {strandedBoats === 1 ? "boat" : "boats"} did not sail for want of crew this season, over{" "}
          <strong data-race-days={metric.raceDaysElapsed}>{metric.raceDaysElapsed}</strong>{" "}
          {metric.raceDaysElapsed === 1 ? "race day" : "race days"} so far.
        </p>
      )}
      <p>
        <strong data-metric={metric.ratio ?? "none"}>{formatRatio(metric)}</strong>{" "}
        {metric.ratio === null ? (
          // Not 0.00: no race day has elapsed, so there is nothing to average. A figure here
          // would report a season that has not started as failing the charter's line.
          <>— the season&rsquo;s crewing cannot be read until a race day has been sailed.</>
        ) : (
          <>
            matches per race day, from <strong>{metric.matches}</strong>{" "}
            {metric.matches === 1 ? "match" : "matches"}. The charter&rsquo;s line is 1.00
            {metric.belowLine ? (
              <strong data-below-line> — below it.</strong>
            ) : (
              <> — at or above it.</>
            )}
          </>
        )}
      </p>

      {dates.length === 0 ? (
        <p data-no-dates>No race dates published yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {["Race day", "Posts", "Matched", "Sailed", "No-show", ""].map((h, i) => (
                <th
                  key={h || `c${i}`}
                  style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: "0.25rem 0.5rem 0.25rem 0" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map((d) => {
              const c = byDate.get(d.id);
              const when = formatStartsAt(d.starts_at);
              return (
                <tr key={d.id} data-date={d.id} data-elapsed={c?.elapsed ?? false}>
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>
                    <a href={`/admin/dates/${d.id}`}>
                      {when.date} — {d.title}
                    </a>
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-posts={c?.posts ?? 0}>
                    {c?.posts ?? 0}
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-matched={c?.matched ?? 0}>
                    {c?.matched ?? 0}
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-sailed={c?.sailed ?? 0}>
                    {c?.sailed ?? 0}
                  </td>
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-no-show={c?.noShow ?? 0}>
                    {c?.noShow ?? 0}
                  </td>
                  {/* The same number, two sentences. See the header: past tense only for a day
                      that has been sailed. */}
                  <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }} data-unmatched={c?.unmatched ?? 0}>
                    {!c || c.unmatched === 0 ? (
                      ""
                    ) : c.elapsed ? (
                      <span data-unmatched-past>
                        {c.unmatched} did not sail for want of crew
                      </span>
                    ) : (
                      <em data-unmatched-future>{c.unmatched} still looking</em>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
