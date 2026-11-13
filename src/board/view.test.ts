import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPast } from "@/availability/rules";
import { BOARD_PATH, BOARD_VIEWS, DEFAULT_VIEW, boardHref, boardView, showsDate, windowDates } from "./view";

/**
 * Story #214: which race days the board shows, and the address of each view.
 *
 * AC 4: "sailed" is `isPast` from the availability rules and nothing else. Proven two ways: at
 *       the one instant where a second definition would most likely differ (a race starting
 *       exactly now, which `isPast` counts as past), and by reading the module's source. The
 *       proof no respelling of the rule can pass is in view-ispast.test.ts: isPast is replaced
 *       there, and the window follows the replacement.
 * AC 7: a view named by a request is read through an allow-list. The Server Action's own test
 *       (src/app/board/actions.test.ts) drives the redirect; this file holds the two functions
 *       the redirect is built from.
 */

const NOW = new Date("2027-06-06T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const date = (id: string, offsetMs: number) => ({ id, starts_at: new Date(NOW.getTime() + offsetMs).toISOString() });
const SEASON = [date("last-week", -7 * 24 * HOUR), date("an-hour-ago", -HOUR), date("in-an-hour", HOUR), date("next-week", 7 * 24 * HOUR)];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("windowDates: the default view starts at the next race (#214 AC 1, AC 2, AC 3)", () => {
  it("the default view shows the dates still to sail, in order, and counts the rest as hidden", () => {
    const w = windowDates(SEASON, NOW, "upcoming");
    expect(ids(w.shown)).toEqual(["in-an-hour", "next-week"]);
    expect(w.hidden).toBe(2);
  });

  it("the full-season view shows every date and hides none", () => {
    const w = windowDates(SEASON, NOW, "season");
    expect(ids(w.shown)).toEqual(["last-week", "an-hour-ago", "in-an-hour", "next-week"]);
    expect(w.hidden).toBe(0);
  });

  it("a race this afternoon is still on the default view", () => {
    // isPast's own rule: a day is past once its START has gone, not once its date has begun.
    expect(ids(windowDates([date("this-afternoon", 5 * HOUR)], NOW, "upcoming").shown)).toEqual(["this-afternoon"]);
  });

  it("between seasons the default view shows nothing and hides every date", () => {
    const sailed = SEASON.slice(0, 2);
    expect(windowDates(sailed, NOW, "upcoming")).toEqual({ shown: [], hidden: 2 });
    expect(ids(windowDates(sailed, NOW, "season").shown)).toEqual(["last-week", "an-hour-ago"]);
  });

  it("with nothing sailed, or no dates at all, nothing is hidden", () => {
    expect(windowDates(SEASON.slice(2), NOW, "upcoming").hidden).toBe(0);
    expect(windowDates([], NOW, "upcoming")).toEqual({ shown: [], hidden: 0 });
    expect(windowDates([], NOW, "season")).toEqual({ shown: [], hidden: 0 });
  });
});

describe("the window's idea of 'sailed' is isPast (#214 AC 4)", () => {
  it("agrees with isPast at the start instant, one millisecond either side, and for every fixture date", () => {
    const edge = [date("a-ms-ago", -1), date("exactly-now", 0), date("in-a-ms", 1)];
    // Control: the boundary is where isPast says it is. A race starting exactly now has started.
    expect(edge.map((d) => isPast(d.starts_at, NOW))).toEqual([true, true, false]);
    expect(ids(windowDates(edge, NOW, "upcoming").shown)).toEqual(["in-a-ms"]);
    for (const d of [...SEASON, ...edge]) {
      const shown = windowDates([d], NOW, "upcoming").shown.length === 1;
      expect(shown, `${d.id}: shown by default exactly when it is not past`).toBe(!isPast(d.starts_at, NOW));
    }
  });

  it("view.ts imports isPast from the availability rules and compares no clock of its own", () => {
    const here = fileURLToPath(new URL("./view.ts", import.meta.url));
    const page = fileURLToPath(new URL("../app/board/page.tsx", import.meta.url));
    const view = readFileSync(here, "utf8");
    expect(view).toMatch(/import \{ isPast \} from "@\/availability\/rules";/);
    // The one place the rule is applied, and the window going through it.
    expect(view).toMatch(/return view === "season" \|\| !isPast\(startsAt, now\);/);
    expect(view).toMatch(/dates\.filter\(\(d\) => showsDate\(view, d\.starts_at, now\)\)/);
    // The window reads the clock only through isPast: no Date method or arithmetic of its own.
    expect(view).not.toMatch(/getTime\(|valueOf\(|toISOString\(|Date\.(now|parse)\(|new Date\(/);
    // And the page decides the day list through windowDates, with isPast left for the toggle.
    const src = readFileSync(page, "utf8");
    expect(src).toMatch(/windowDates\(dates \?\? \[\], now, view\)/);
    expect(src).toMatch(/\{shown\.map\(\(d\) =>/);
    expect(src).not.toMatch(/\{dates\.map\(/);
  });
});

describe("boardView: only a view on the allow-list is a view (#214 AC 7)", () => {
  it("the allow-list is the two views, and the default is the upcoming one", () => {
    expect([...BOARD_VIEWS]).toEqual(["upcoming", "season"]);
    expect(DEFAULT_VIEW).toBe("upcoming");
  });

  it.each(BOARD_VIEWS.map((v) => [v]))("%s is itself", (v) => {
    expect(boardView(v)).toBe(v);
  });

  it.each([
    ["nothing", undefined],
    ["null, as FormData gives for a missing field", null],
    ["an empty string", ""],
    ["an absolute URL", "https://evil.example/board"],
    ["a //host value", "//evil.example"],
    ["a backslash host", "/\\evil.example"],
    ["a path", "/board"],
    ["the view with a path after it", "season/../../join"],
    ["the view with a query after it", "season?next=//evil.example"],
    ["the view with a fragment after it", "season#x"],
    ["a script URL", "javascript:alert(1)"],
    ["another case", "SEASON"],
    ["padding", " season "],
    ["a repeated parameter, which arrives as an array", ["season", "season"]],
    ["an array of one", ["season"]],
    ["an object", { view: "season" }],
    ["a number", 1],
    ["a File-shaped form value", { name: "season", size: 0 }],
  ])("%s is the default view", (_name, value) => {
    expect(boardView(value)).toBe(DEFAULT_VIEW);
  });
});

describe("boardHref: every address starts at /board", () => {
  it("the default view's plain addresses are the ones the board has always had", () => {
    expect(BOARD_PATH).toBe("/board");
    expect(boardHref("upcoming")).toBe("/board");
    expect(boardHref("upcoming", { error: "past" })).toBe("/board?error=past");
  });

  it("a row ends the address at that row, in either view", () => {
    expect(boardHref("upcoming", { row: "abc" })).toBe("/board#abc");
    expect(boardHref("season", { row: "abc" })).toBe("/board?view=season#abc");
  });

  it("the full-season view carries its name, then the error", () => {
    expect(boardHref("season")).toBe("/board?view=season");
    expect(boardHref("season", { error: "no-rating" })).toBe("/board?view=season&error=no-rating");
  });

  it("an error with a row names the row in the query too, because a server never sees the fragment", () => {
    expect(boardHref("season", { error: "refused", row: "abc" })).toBe("/board?view=season&error=refused&on=abc#abc");
    expect(boardHref("upcoming", { error: "refused", row: "abc" })).toBe("/board?error=refused&on=abc#abc");
    // No error, no `on`: the query names a row only to say where a refusal belongs.
    expect(new URL(boardHref("season", { row: "abc" }), "https://tender.example").searchParams.has("on")).toBe(false);
    // An error with no row is an address with no fragment: the member lands at the top.
    expect(new URL(boardHref("season", { error: "refused" }), "https://tender.example").hash).toBe("");
  });

  it("an error is a query value, so text in it cannot end the query or start a fragment", () => {
    const href = boardHref("season", { error: "x&view=upcoming#top" });
    const url = new URL(href, "https://tender.example");
    expect(url.pathname).toBe("/board");
    expect(url.searchParams.get("view")).toBe("season");
    expect(url.searchParams.get("error")).toBe("x&view=upcoming#top");
    expect(url.hash).toBe("");
  });
});

describe("showsDate: whether a view lists a date, which is also whether a redirect may end at its row", () => {
  const sailed = date("sailed", -HOUR).starts_at;
  const upcoming = date("upcoming", HOUR).starts_at;

  it("the full season lists both; the default view lists only the one still to sail", () => {
    expect(showsDate("season", sailed, NOW)).toBe(true);
    expect(showsDate("season", upcoming, NOW)).toBe(true);
    expect(showsDate("upcoming", upcoming, NOW)).toBe(true);
    expect(showsDate("upcoming", sailed, NOW)).toBe(false);
  });

  it("agrees with windowDates for every fixture date in both views", () => {
    for (const view of BOARD_VIEWS) {
      for (const d of SEASON) {
        expect(windowDates([d], NOW, view).shown.length === 1, `${view} ${d.id}`).toBe(showsDate(view, d.starts_at, NOW));
      }
    }
  });
});
