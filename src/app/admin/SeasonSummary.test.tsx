import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { boatsWithoutCrew, countsByDate, type SeasonDate, type SeasonMatchRow, type SeasonPost } from "@/admin/season";
import { seasonMetric } from "@/lib/metric";
import { SeasonSummary } from "./SeasonSummary";

/**
 * Story #38 AC 2. /admin prints the season's two headline numbers and a row per race day. The
 * page is an async Server Component that reads the session and the database, so the readings are
 * rendered here from the component the page hands its figures to.
 *
 * Stated blind spot: this never runs the page's own selects. That `loadSeasonData` reads columns
 * an admin may actually read is test/admin-season.test.ts's job (real SQL); the spelling of the
 * select is exercised by neither, and the first run of /admin after promotion is its first test.
 *
 * Assertions read attribute values rather than prose wherever a number is the claim — React
 * renders a bare boolean data attribute as `data-x="true"` (#145), so booleans are matched
 * loosely and never assumed empty.
 */

const NOW = new Date("2026-06-15T12:00:00Z");
const PAST = "2026-05-01T17:00:00Z";
const FUTURE = "2026-07-01T17:00:00Z";

const DATES: SeasonDate[] = [
  { id: "d-past", starts_at: PAST, title: "Spring 1", published: true },
  { id: "d-future", starts_at: FUTURE, title: "Summer 1", published: true },
];

function post(id: string, dateId: string): SeasonPost {
  return { id, boat_id: `b-${id}`, race_date_id: dateId, minimum: 2, closed_at: null, current_rung: 1 };
}

function match(postId: string, status: SeasonMatchRow["status"]): SeasonMatchRow {
  return { id: `m-${postId}`, post_id: postId, skipper_id: "sk", crew_id: "cr", status };
}

/** The value of a `data-` attribute on any element, or undefined. */
function attr(html: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
}

function render(posts: SeasonPost[], matches: SeasonMatchRow[], dates = DATES): string {
  const counts = countsByDate(dates, posts, matches, NOW);
  return renderToStaticMarkup(
    <SeasonSummary
      dates={dates}
      counts={counts}
      metric={seasonMetric(matches, dates, NOW)}
      strandedBoats={boatsWithoutCrew(counts)}
    />,
  );
}

describe("SeasonSummary — the headline numbers", () => {
  it("prints the stranded count and the metric to two decimals", () => {
    // One elapsed day, two posts, one matched: 1 match / 1 elapsed day = 1.00, one boat stranded.
    const html = render([post("a", "d-past"), post("b", "d-past")], [match("a", "sailed")]);
    expect(attr(html, "data-stranded-boats")).toBe("1");
    expect(attr(html, "data-race-days")).toBe("1");
    expect(attr(html, "data-metric")).toBe("1");
    expect(html).toContain("1.00");
    expect(html).toContain("did not sail for want of crew");
  });

  it("says the season cannot be read yet rather than printing 0.00", () => {
    // The case the whole metric module exists for: no elapsed race day.
    const html = render([post("a", "d-future")], [], [DATES[1]]);
    expect(attr(html, "data-metric")).toBe("none");
    expect(html).toContain("no race days yet");
    expect(html).toContain("cannot be read until a race day has been sailed");
    // And it must not claim the charter's line has been failed.
    expect(html).not.toContain("data-below-line");
  });

  it("does not make the past-tense claim over a season with no elapsed race day", () => {
    // "0 boats did not sail for want of crew" reads as a clean record and is no record at all —
    // the prose form of the 0.00 mistake the metric module refuses.
    const html = render([post("a", "d-future")], [], [DATES[1]]);
    expect(html).toContain("data-not-started");
    expect(html).toContain("No race day has been sailed yet");
    expect(html).not.toContain("did not sail for want of crew");
  });

  it("marks a season below the charter's line", () => {
    const html = render([post("a", "d-past"), post("b", "d-past")], []);
    expect(attr(html, "data-metric")).toBe("0");
    expect(html).toContain("data-below-line");
    expect(html).toContain("below it");
  });

  it("does not mark a season at the line as below it", () => {
    const html = render([post("a", "d-past")], [match("a", "confirmed")]);
    expect(html).not.toContain("data-below-line");
    expect(html).toContain("at or above it");
  });

  it("pluralises one boat and one race day", () => {
    const html = render([post("a", "d-past")], []);
    expect(html).toContain("boat did not sail");
    expect(html).toContain("race day so far");
  });
});

describe("SeasonSummary — the per-day rows", () => {
  it("prints counts per date and links to that day's screen", () => {
    const html = render(
      [post("a", "d-past"), post("b", "d-past"), post("c", "d-past")],
      [match("a", "sailed"), match("b", "no_show")],
    );
    expect(html).toContain('href="/admin/dates/d-past"');
    expect(attr(html, "data-posts")).toBe("3");
    expect(attr(html, "data-matched")).toBe("2");
    expect(attr(html, "data-sailed")).toBe("1");
    expect(attr(html, "data-no-show")).toBe("1");
  });

  it("words a future day's open posts as still looking, never as did not sail", () => {
    // The owner's decision: the figure is shown for a future date, in different words. The two
    // must not be spelled the same, or the same number makes two different claims.
    const html = render([post("c", "d-future")], [], [DATES[1]]);
    expect(html).toContain("data-unmatched-future");
    expect(html).toContain("still looking");
    expect(html).not.toContain("data-unmatched-past");
    expect(html).not.toContain("did not sail for want of crew");
  });

  it("words an elapsed day's open posts in the past tense", () => {
    const html = render([post("a", "d-past")], [], [DATES[0]]);
    expect(html).toContain("data-unmatched-past");
    expect(html).toContain("did not sail for want of crew");
    expect(html).not.toContain("still looking");
  });

  it("keeps a future day out of the season's stranded total", () => {
    // Two open posts, one on each date. Only the elapsed one is a boat that did not sail.
    const html = render([post("a", "d-past"), post("c", "d-future")], []);
    expect(attr(html, "data-stranded-boats")).toBe("1");
    expect(html).toContain("data-unmatched-future");
  });

  it("marks each row elapsed or not", () => {
    const html = render([], []);
    expect(html).toContain('data-date="d-past" data-elapsed="true"');
    expect(html).toContain('data-date="d-future" data-elapsed="false"');
  });

  it("says so when no date is published", () => {
    const html = render([], [], []);
    expect(html).toContain("data-no-dates");
    expect(html).toContain("No race dates published yet");
  });

  it("prints nothing in the unmatched column when every post found crew", () => {
    const html = render([post("a", "d-past")], [match("a", "sailed")]);
    expect(html).not.toContain("data-unmatched-past");
    expect(html).not.toContain("data-unmatched-future");
  });
});
