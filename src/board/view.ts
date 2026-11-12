import { isPast } from "@/availability/rules";

/**
 * Which race days /board shows (story #214). The default view starts at the next race: every
 * published date still to sail, with the ones already sailed one link away in the full-season
 * view. There is no cap on upcoming dates (owner decision at the filing gate, 2026-09-22).
 *
 * This is a window over what `loadBoardData()` read, applied by the board page. The loader is
 * unchanged, because /post/[id] reads through it too and a post on a sailed date must still
 * render.
 *
 * "Sailed" is `isPast` from the availability rules, the same function that disables a day's
 * toggle and refuses the Server Action, so the list and the button cannot disagree about a date.
 */

export const BOARD_PATH = "/board";

/** The allow-list. A view is named in a URL and in a form field, so it is never trusted as text. */
export const BOARD_VIEWS = ["upcoming", "season"] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];
export const DEFAULT_VIEW: BoardView = "upcoming";

/**
 * The view a request named, or the default for anything else: a missing value, a repeated
 * parameter (an array), a different spelling, a URL. Only a value from the allow-list comes back,
 * so what `boardHref` writes into a redirect is one of two constants and never the caller's text.
 */
export function boardView(value: unknown): BoardView {
  return BOARD_VIEWS.find((v) => v === value) ?? DEFAULT_VIEW;
}

/**
 * The board's address for a view. Always begins with `BOARD_PATH`. The default view carries no
 * `view` parameter, so a plain link to the board is the address it has always had.
 *
 * `row` is a race date's id, for a caller that knows the date's row is on the page it is sending
 * the member to. The address then ends at that row (`#<id>`), which is where the browser scrolls
 * and where the next Tab starts from. With an error as well, the row is also named in the query
 * (`on`), because a server never sees a fragment and the page shows the refusal inside that row:
 * a sentence at the top of a list the member has been scrolled away from is one they never read.
 */
export function boardHref(view: BoardView, opts: { error?: string; row?: string } = {}): string {
  const query = new URLSearchParams();
  if (view !== DEFAULT_VIEW) query.set("view", view);
  if (opts.error) query.set("error", opts.error);
  if (opts.error && opts.row) query.set("on", opts.row);
  const search = query.toString();
  return `${BOARD_PATH}${search ? `?${search}` : ""}${opts.row ? `#${opts.row}` : ""}`;
}

/** Whether a view lists a date starting at `startsAt`: the full season lists every date, the default only those still to sail. */
export function showsDate(view: BoardView, startsAt: string, now: Date): boolean {
  return view === "season" || !isPast(startsAt, now);
}

/**
 * The dates a view shows, in the order given, and how many it leaves out. `hidden` is what the
 * full-season link counts, and it is 0 in the full-season view by construction.
 */
export function windowDates<T extends { starts_at: string }>(
  dates: readonly T[],
  now: Date,
  view: BoardView,
): { shown: T[]; hidden: number } {
  const shown = dates.filter((d) => showsDate(view, d.starts_at, now));
  return { shown, hidden: dates.length - shown.length };
}
