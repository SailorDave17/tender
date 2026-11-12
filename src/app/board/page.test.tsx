import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IDS, ME, NOW, RACE_DATES, POSTS, TABLES, fakeClient, uuid, type Tables } from "../../../test/surfaces";

/**
 * Story #214: the board's two views, as the server renders them. The page is the real Server
 * Component over test/surfaces.ts's fake client; `Date` is pinned to the fixture's `NOW`, where
 * d-past sailed a week ago and d-next and d-later are still to come.
 *
 * AC 1: the default view lists [d-next, d-later].
 * AC 2: a server-rendered link counts the sailed dates left out and opens the full-season view,
 *       which lists all three with d-past's toggle disabled. With nothing hidden, no link.
 * AC 3: dates published but none upcoming is its own message plus the link, and 'The season has
 *       no dates yet.' is kept for a season with no published date.
 * AC 5: /post/[id] for a post on a sailed date still renders. It reads the same loader, so this
 *       is the test that fails if the window is ever moved into loadBoardData().
 *
 * The Chrome reading of the same two views at 390px is test/surfaces.test.ts's.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => holder.client }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/app/board/actions", () => ({ setAvailability: async () => undefined }));
vi.mock("@/app/post/actions", () => ({
  acceptAnswer: async () => undefined,
  answerPost: async () => undefined,
  closePost: async () => undefined,
  setMatchStatus: async () => undefined,
  createPost: async () => undefined,
}));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

type Params = { view?: string | string[]; error?: string; on?: string | string[] };
async function board(searchParams: Params = {}, tables: Tables = TABLES, as: string = ME): Promise<string> {
  holder.client = fakeClient(as, tables);
  const { default: BoardPage } = await import("./page");
  return renderToStaticMarkup(await BoardPage({ searchParams: Promise.resolve(searchParams) }));
}

const dayIds = (html: string) => [...html.matchAll(/<li[^>]*\bdata-race-date="([^"]+)"/g)].map((m) => m[1]);
/** One day's own markup: from its `<li>` to the next day's, or to the end of the list. */
function day(html: string, id: string): string {
  const start = html.indexOf(`data-race-date="${id}"`);
  if (start < 0) throw new Error(`no row for ${id}`);
  const next = html.indexOf("data-race-date=", start + 1);
  return html.slice(start, next < 0 ? html.indexOf("</ol>", start) : next);
}
const FULL_SEASON_LINK = /<a\b[^>]*\bdata-full-season\b[^>]*>([^<]*)<\/a>/;
const UPCOMING_LINK = /<a\b[^>]*\bdata-upcoming-only\b[^>]*>([^<]*)<\/a>/;
const href = (a: string) => /\bhref="([^"]*)"/.exec(a)?.[1];
const unescape = (s: string) => s.replace(/&amp;/g, "&");

const only = (ids: string[]): Tables => ({ ...TABLES, race_date: RACE_DATES.filter((d) => ids.includes(d.id)) });
const SAILED_TOO = { id: "d-older", starts_at: new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(), title: "Sunday series 0", published: true };

describe("/board opens at the next race (#214 AC 1)", () => {
  it("the default view lists the dates still to sail, and not the one already sailed", async () => {
    const html = await board();
    // Control: the fixture does hold a sailed date, so its absence is the window's doing.
    expect(RACE_DATES.map((d) => d.id)).toEqual(["d-past", "d-next", "d-later"]);
    expect(dayIds(html)).toEqual(["d-next", "d-later"]);
    expect(html).not.toContain("Sunday series 1");
    expect(html).not.toContain("Already sailed");
    // No toggle in the default view names a view, so its form posts what it always did.
    expect(html).not.toMatch(/name="view"/);
  });

  it.each([
    ["an absolute URL", "https://evil.example/board"],
    ["a //host value", "//evil.example"],
    ["another spelling", "SEASON"],
    ["a repeated parameter", ["season", "season"]],
  ])("a view that is not on the allow-list (%s) is the default view", async (_name, view) => {
    const html = await board({ view });
    expect(dayIds(html)).toEqual(["d-next", "d-later"]);
    expect(html).not.toMatch(/name="view"/);
    expect(html).not.toContain("evil");
  });
});

describe("the sailed dates are one link away (#214 AC 2)", () => {
  it("the default view's link says how many are hidden and opens the full-season view", async () => {
    const html = await board();
    const link = FULL_SEASON_LINK.exec(html);
    expect(link, "a server-rendered full-season link").not.toBeNull();
    expect(link![1]).toBe("Show the whole season (1 already sailed)");
    expect(unescape(href(link![0])!)).toBe("/board?view=season");
    expect(link![0]).toMatch(/data-hidden-dates="1"/);
    expect(UPCOMING_LINK.test(html), "no way-back link on the view it would lead to").toBe(false);
  });

  it("each view's link to the other sits above the day list, not under it (owner decision at review)", async () => {
    // Under the list, the full-season link was 4.8 screens down a mid-season board (measured).
    const dflt = await board();
    expect(dflt.indexOf("<h2>Race days</h2>")).toBeGreaterThan(-1);
    expect(dflt.indexOf("<h2>Race days</h2>")).toBeLessThan(dflt.indexOf("data-full-season"));
    expect(dflt.indexOf("data-full-season")).toBeLessThan(dflt.indexOf("<ol"));
    const season = await board({ view: "season" });
    expect(season.indexOf("<h2>Race days</h2>")).toBeLessThan(season.indexOf("data-upcoming-only"));
    expect(season.indexOf("data-upcoming-only")).toBeLessThan(season.indexOf("<ol"));
  });

  it("every day's row carries its date's id as its own id, in both views: what a #anchor lands on (AC 6)", async () => {
    // The action's redirect ends at `#<race_date_id>`, and /post/[id] links to `/board#<id>`.
    // Neither test of those addresses can see whether anything on the page answers to the id.
    for (const [view, ids] of [[undefined, ["d-next", "d-later"]], ["season", ["d-past", "d-next", "d-later"]]] as const) {
      const html = await board(view ? { view } : {});
      const rows = [...html.matchAll(/<li\b([^>]*\bdata-race-date="[^"]+"[^>]*)>/g)].map((m) => ({
        id: /(?:^|\s)id="([^"]*)"/.exec(m[1])?.[1],
        date: /\bdata-race-date="([^"]*)"/.exec(m[1])?.[1],
      }));
      expect(rows.map((r) => r.date)).toEqual([...ids]);
      for (const r of rows) expect(r.id, `the row for ${r.date}`).toBe(r.date);
      // And an id is on one element only, or the browser lands on the first of them.
      for (const id of ids) expect(html.split(` id="${id}"`).length - 1, `elements with id ${id}`).toBe(1);
    }
  });

  it("the count is the number hidden: two sailed dates read 2", async () => {
    const html = await board({}, { ...TABLES, race_date: [SAILED_TOO, ...RACE_DATES] });
    expect(dayIds(html)).toEqual(["d-next", "d-later"]);
    expect(FULL_SEASON_LINK.exec(html)![1]).toBe("Show the whole season (2 already sailed)");
  });

  it("the full-season view lists every date, with the sailed one's toggle disabled", async () => {
    const html = await board({ view: "season" });
    expect(dayIds(html)).toEqual(["d-past", "d-next", "d-later"]);
    const past = day(html, "d-past");
    expect(past).toMatch(/data-past="true"/);
    expect(past).toMatch(/<button\b[^>]*\bdisabled=""[^>]*>Already sailed<\/button>/);
    // Control: a date still to sail keeps a live toggle, so `disabled` is the sailed date's alone.
    const next = day(html, "d-next");
    expect(next).toMatch(/data-past="false"/);
    expect(next).toMatch(/<button\b[^>]*>I can(?:&#x27;|')t make it after all<\/button>/);
    expect(next).not.toMatch(/\bdisabled=""/);
    // Nothing is hidden here, so the full-season link is gone and the way back is offered.
    expect(FULL_SEASON_LINK.test(html)).toBe(false);
    const back = UPCOMING_LINK.exec(html);
    expect(back![1]).toBe("Upcoming dates only");
    expect(href(back![0])).toBe("/board");
  });

  it("every toggle in the full-season view carries the view, so the action can come back to it (AC 6)", async () => {
    const html = await board({ view: "season" });
    const forms = [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((m) => m[0]).filter((f) => f.includes('name="race_date_id"'));
    expect(forms).toHaveLength(3);
    for (const f of forms) expect(f).toMatch(/<input type="hidden" name="view" value="season"\/>/);
  });

  it("when no date is hidden, the link is absent", async () => {
    const html = await board({}, only(["d-next", "d-later"]));
    expect(dayIds(html)).toEqual(["d-next", "d-later"]);
    expect(FULL_SEASON_LINK.test(html)).toBe(false);
    expect(html).not.toContain("already sailed");
  });
});

describe("a refused toggle's reason is shown in the row the member is sent back to (#214 AC 6, 'with the error kept')", () => {
  const PAST_SENTENCE = "That race day has already started.";
  const alerts = (html: string) => [...html.matchAll(/<p\b[^>]*\brole="alert"[^>]*>([^<]*)<\/p>/g)].map((m) => m[0]);
  const IN_ROW = /<p role="alert" data-day-refusal(?:="[^"]*")?>([^<]*)<\/p>/;

  it("in the full-season view the sentence is inside the sailed date's row, first in it, and nowhere else", async () => {
    const html = await board({ view: "season", error: "past", on: "d-past" });
    const row = day(html, "d-past");
    expect(IN_ROW.exec(row)?.[1]).toBe(PAST_SENTENCE);
    // First in the row: the action scrolls the row to the top of the screen, so the sentence
    // is the first thing under it. Before #214's review it was above the list, 1,470px off-screen.
    expect(row.indexOf("data-day-refusal")).toBeLessThan(row.indexOf("data-day="));
    expect(alerts(html), "one alert, so a screen reader hears the reason once").toHaveLength(1);
    expect(IN_ROW.test(day(html, "d-next"))).toBe(false);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf("<ol"));
  });

  it("in the default view too, for a date it lists", async () => {
    const html = await board({ error: "no-rating", on: "d-later" });
    expect(IN_ROW.exec(day(html, "d-later"))?.[1]).toBe("Set your competence on your profile before marking a day.");
    expect(alerts(html)).toHaveLength(1);
  });

  it.each([
    ["a date the view does not list", { error: "past", on: "d-past" }],
    ["no row named", { error: "past" }],
    ["a row that is no date", { error: "past", on: "https://evil.example/" }],
    ["a repeated parameter", { error: "past", on: ["d-next", "d-next"] }],
  ] as [string, Params][])("with %s, the sentence stays above the list, once", async (_name, params) => {
    const html = await board(params);
    expect(alerts(html)).toEqual([`<p role="alert">${PAST_SENTENCE}</p>`]);
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf("<h2>Race days</h2>"));
    expect(html).not.toContain("data-day-refusal");
    expect(html).not.toContain("evil");
  });

  it("a row named with no error shows nothing: `on` only says where a refusal belongs", async () => {
    const html = await board({ view: "season", on: "d-past" });
    expect(alerts(html)).toEqual([]);
  });

  it("a refusal from another screen (a post action's ?error=refused) still reads above the list", async () => {
    // src/app/post/actions.ts redirects to /board?error=refused with no row.
    const html = await board({ error: "refused" });
    expect(alerts(html)).toHaveLength(1);
    expect(html).not.toContain("data-day-refusal");
  });
});

describe("published dates, none upcoming: the board between seasons (#214 AC 3)", () => {
  it("says so, offers the full season, and does not render an empty list", async () => {
    const html = await board({}, { ...TABLES, race_date: [SAILED_TOO, RACE_DATES[0]] });
    expect(html).toMatch(/<p data-no-upcoming(?:="[^"]*")?>No upcoming race dates\.<\/p>/);
    // The message first, then the way to the season it refers to.
    expect(html.indexOf("data-no-upcoming")).toBeLessThan(html.indexOf("data-full-season"));
    expect(FULL_SEASON_LINK.exec(html)![1]).toBe("Show the whole season (2 already sailed)");
    expect(html).not.toContain("<ol");
    expect(dayIds(html)).toEqual([]);
    expect(html).not.toContain("The season has no dates yet.");
  });

  it("the full-season view of the same season lists both sailed dates", async () => {
    const html = await board({ view: "season" }, { ...TABLES, race_date: [SAILED_TOO, RACE_DATES[0]] });
    expect(dayIds(html)).toEqual(["d-older", "d-past"]);
    expect(html).not.toContain("No upcoming race dates.");
  });

  it.each([["the default view", {}], ["the full-season view", { view: "season" }]] as [string, Params][])(
    "'The season has no dates yet.' renders only when no date is published: %s",
    async (_name, params) => {
      const html = await board(params, { ...TABLES, race_date: [] });
      expect(html).toContain("<p>The season has no dates yet.</p>");
      expect(html).not.toContain("No upcoming race dates.");
      expect(FULL_SEASON_LINK.test(html)).toBe(false);
      expect(UPCOMING_LINK.test(html)).toBe(false);
    },
  );

  it("control: with dates upcoming, neither empty message renders", async () => {
    const html = await board();
    expect(html).not.toContain("No upcoming race dates.");
    expect(html).not.toContain("The season has no dates yet.");
  });
});

describe("/post/[id] for a sailed date still renders (#214 AC 5)", () => {
  const PAST_POST = { id: uuid(14), boat_id: IDS.boatMoon, race_date_id: "d-past", minimum: 2 as const, note: "", closed_at: null, current_rung: 3 as const };

  it("a crew opening a post on a date the default board no longer lists gets the post, not 'Not here'", async () => {
    const tables = { ...TABLES, post: [...POSTS, PAST_POST] };
    // The default board has no row for the date this post is on.
    expect(dayIds(await board({}, tables))).not.toContain("d-past");
    holder.client = fakeClient("p-cy", tables);
    const { default: PostPage } = await import("../post/[id]/page");
    // notFound() throws, so a post page that could not find its date fails this await.
    const html = renderToStaticMarkup(await PostPage({ params: Promise.resolve({ id: PAST_POST.id }), searchParams: Promise.resolve({}) }));
    expect(html).toContain(`data-post="${PAST_POST.id}"`);
    expect(html).toContain("Sunday series 1");
    expect(html).toMatch(/<p data-status="past">This race has started\.<\/p>/);
  });
});
