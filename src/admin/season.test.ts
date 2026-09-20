import { describe, expect, it } from "vitest";
import {
  boatsWithoutCrew,
  countsByDate,
  raceDayRows,
  type SeasonBoat,
  type SeasonDate,
  type SeasonMatchRow,
  type SeasonPerson,
  type SeasonPost,
} from "./season";

/**
 * Story #38 AC 1 and AC 2 — the per-day counts and the detail screen's rows.
 *
 * Two cases here are the ones that would ship silently wrong: a hand-closed post with no match
 * (which `closed_at` would call crewed), and a post on a race day still to come (which a naive
 * sum would call a boat that did not sail).
 */

const NOW = new Date("2026-06-15T12:00:00Z");
const PAST = "2026-05-01T17:00:00Z";
const ALSO_PAST = "2026-05-08T17:00:00Z";
const FUTURE = "2026-07-01T17:00:00Z";

const DATES: SeasonDate[] = [
  { id: "past", starts_at: PAST, title: "Spring 1", published: true },
  { id: "past2", starts_at: ALSO_PAST, title: "Spring 2", published: true },
  { id: "future", starts_at: FUTURE, title: "Summer 1", published: true },
];

function post(id: string, dateId: string, over: Partial<SeasonPost> = {}): SeasonPost {
  return {
    id,
    boat_id: `boat-${id}`,
    race_date_id: dateId,
    minimum: 2,
    closed_at: null,
    current_rung: 1,
    ...over,
  };
}

function match(postId: string, status: SeasonMatchRow["status"]): SeasonMatchRow {
  return { id: `m-${postId}`, post_id: postId, skipper_id: `sk-${postId}`, crew_id: `cr-${postId}`, status };
}

describe("countsByDate", () => {
  it("counts posts, matched, sailed and no-show per date", () => {
    const posts = [post("a", "past"), post("b", "past"), post("c", "past"), post("d", "past2")];
    const matches = [match("a", "sailed"), match("b", "no_show"), match("d", "accepted")];
    const [first, second, future] = countsByDate(DATES, posts, matches, NOW);

    expect(first).toEqual({
      dateId: "past",
      posts: 3,
      matched: 2,
      sailed: 1,
      noShow: 1,
      unmatched: 1,
      elapsed: true,
    });
    expect(second.matched).toBe(1);
    // An accepted match on a sailed day is neither sailed nor no-show, and that is worth seeing.
    expect([second.sailed, second.noShow]).toEqual([0, 0]);
    expect(future.posts).toBe(0);
  });

  it("does NOT read closed_at as matched — a hand-closed post is still unmatched", () => {
    // accept_answer() closes a post, but a skipper can close one by hand with nobody on it.
    // Reading closed_at as "crewed" is the silent under-report this test exists to stop.
    const posts = [post("lonely", "past", { closed_at: "2026-04-30T12:00:00Z" })];
    const [c] = countsByDate([DATES[0]], posts, [], NOW);
    expect(c.matched).toBe(0);
    expect(c.unmatched).toBe(1);
  });

  it("marks a future date not elapsed", () => {
    const [c] = countsByDate([DATES[2]], [post("x", "future")], [], NOW);
    expect(c.elapsed).toBe(false);
    // The figure is still computed — the screen labels it provisional (owner decision).
    expect(c.unmatched).toBe(1);
  });

  it("treats a date starting exactly at now as elapsed", () => {
    const at: SeasonDate = { id: "now", starts_at: NOW.toISOString(), title: "Now", published: true };
    expect(countsByDate([at], [], [], NOW)[0].elapsed).toBe(true);
  });

  it("returns a row per date even where nothing was posted", () => {
    expect(countsByDate(DATES, [], [], NOW).map((c) => c.posts)).toEqual([0, 0, 0]);
  });
});

describe("boatsWithoutCrew", () => {
  it("sums unmatched posts over elapsed days only", () => {
    const posts = [post("a", "past"), post("b", "past2"), post("c", "future"), post("d", "future")];
    const counts = countsByDate(DATES, posts, [], NOW);
    // Two stranded boats, not four: the July posts are still looking.
    expect(boatsWithoutCrew(counts)).toBe(2);
  });

  it("is zero for a club that has just published its calendar", () => {
    const posts = [post("a", "future"), post("b", "future")];
    expect(boatsWithoutCrew(countsByDate(DATES, posts, [], NOW))).toBe(0);
  });

  it("is zero when every elapsed post found crew", () => {
    const posts = [post("a", "past"), post("b", "past2")];
    const counts = countsByDate(DATES, posts, [match("a", "sailed"), match("b", "confirmed")], NOW);
    expect(boatsWithoutCrew(counts)).toBe(0);
  });
});

describe("raceDayRows", () => {
  const boats = new Map<string, SeasonBoat>([
    ["boat-a", { id: "boat-a", owner_id: "sk-a", name: "Zephyr", class: "Thistle" }],
    ["boat-b", { id: "boat-b", owner_id: "sk-b", name: "Albatross", class: "Lightning" }],
  ]);
  const people = new Map<string, SeasonPerson>([
    ["sk-a", { id: "sk-a", display_name: "Dave" }],
    ["sk-b", { id: "sk-b", display_name: "Pat" }],
    ["cr-a", { id: "cr-a", display_name: "Sam" }],
  ]);

  it("lists a matched post with its crew and status, and an unmatched one as open", () => {
    const posts = [post("a", "past", { current_rung: 2 }), post("b", "past")];
    const rows = raceDayRows("past", posts, [match("a", "sailed")], boats, people);
    // Sorted by boat name: Albatross before Zephyr.
    expect(rows.map((r) => r.boatName)).toEqual(["Albatross", "Zephyr"]);

    const zephyr = rows.find((r) => r.boatName === "Zephyr")!;
    expect(zephyr).toMatchObject({
      boatClass: "Thistle",
      minimum: 2,
      finalRung: 2,
      skipper: "Dave",
      crew: "Sam",
      status: "sailed",
      open: false,
    });

    const albatross = rows.find((r) => r.boatName === "Albatross")!;
    expect(albatross.open).toBe(true);
    expect(albatross.crew).toBeNull();
    expect(albatross.status).toBeNull();
  });

  it("carries the STORED rung, not one derived from the clock", () => {
    // The whole point of the departure from post-view.ts: a past race would compute rung 3 for
    // every post. A post that filled at rung 1 must still read 1 months later.
    const posts = [post("a", "past", { current_rung: 1 })];
    expect(raceDayRows("past", posts, [match("a", "sailed")], boats, people)[0].finalRung).toBe(1);
  });

  it("keeps an anonymised match as a match, not as an open post", () => {
    // AC 3's rule where the screen meets it: the crew is unreadable, the match is not.
    const posts = [post("b", "past")];
    const rows = raceDayRows("past", posts, [match("b", "confirmed")], boats, people);
    expect(rows[0].crew).toBeNull();
    expect(rows[0].open).toBe(false);
    expect(rows[0].status).toBe("confirmed");
  });

  it("keeps a post whose boat is gone", () => {
    const rows = raceDayRows("past", [post("ghost", "past")], [], boats, people);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boatName: "(removed)", boatClass: "(removed)", skipper: null });
  });

  it("returns only the named date's posts", () => {
    const posts = [post("a", "past"), post("b", "past2")];
    expect(raceDayRows("past2", posts, [], boats, people).map((r) => r.postId)).toEqual(["b"]);
  });

  it("is empty for a date with no posts", () => {
    expect(raceDayRows("future", [post("a", "past")], [], boats, people)).toEqual([]);
  });
});
