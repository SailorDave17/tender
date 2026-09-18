/**
 * What a match means to whoever is looking at it (story #21 AC 5). Pure, so the three views —
 * the skipper's, the crew's, everyone else's — are decided once here and tested from the
 * rendered HTML in MatchPanel.test.tsx rather than inferred from a page.
 *
 * The database is the first layer: person_contact's select policy (0008) hands a page the
 * counterparty's row for a party and zero rows for anyone else. This module and MatchPanel are
 * the second: a page that somehow holds a contact row still renders it only to a party, so a
 * later wider read cannot leak here by accident — the same two-layer shape as ProfileCard.
 */

import { localDate } from "@/dates/race-date";

/** 0008's list. Only 'accepted' is written at the match; 0021's definer moves it (story #37). */
export type MatchStatus = "accepted" | "confirmed" | "sailed" | "no_show";

export type MatchRow = {
  id: string;
  post_id: string;
  skipper_id: string;
  crew_id: string;
  accepted_at: string;
  status: MatchStatus;
};

export type MatchRole = "skipper" | "crew" | "other";

export function matchRole(match: Pick<MatchRow, "skipper_id" | "crew_id">, viewerId: string): MatchRole {
  if (viewerId === match.skipper_id) return "skipper";
  if (viewerId === match.crew_id) return "crew";
  return "other";
}

/** The person a party is matched with; null for anyone who is not a party. */
export function counterpartyOf(match: Pick<MatchRow, "skipper_id" | "crew_id">, viewerId: string): string | null {
  switch (matchRole(match, viewerId)) {
    case "skipper":
      return match.crew_id;
    case "crew":
      return match.skipper_id;
    default:
      return null;
  }
}

/** The statuses a person can set from the page; 'accepted' is the match's birth state and is never set. */
export const SETTABLE_STATUSES = ["confirmed", "sailed", "no_show"] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export function isSettableStatus(value: string): value is SettableStatus {
  return (SETTABLE_STATUSES as readonly string[]).includes(value);
}

/**
 * How a status reads, everywhere it is shown — the match panel, the board's crewed line, the
 * crew's own row (story #37 AC 4: nothing is hidden from them). Empty for 'accepted', because
 * 'Matched' and 'Crewed' already say that.
 */
export function statusLabel(status: MatchStatus): string {
  switch (status) {
    case "confirmed":
      return "Confirmed";
    case "sailed":
      return "Sailed";
    case "no_show":
      return "Did not show";
    default:
      return "";
  }
}

export type MatchControls = {
  /** The crew's Confirm button: race day (club zone), match still accepted. */
  confirm: boolean;
  /** The skipper's Sailed / Did not show buttons: after the start, match not yet final. */
  record: boolean;
};

/**
 * Which buttons a viewer gets, as a pure decision over `now` (story #37 AC 3, AC 4). The page
 * renders these; the database decides again inside set_match_status() (0021) — a button is a
 * courtesy and not a guard, and a crafted POST outside the window is refused there whatever this
 * says. The two windows are the definer's, restated: the crew confirms on the race's calendar
 * day in the club's zone (from 00:00, even after the start), and the skipper records the outcome
 * only after the start.
 */
export function matchControls(
  match: Pick<MatchRow, "skipper_id" | "crew_id" | "status">,
  startsAt: string | Date,
  viewerId: string,
  now: Date,
): MatchControls {
  const role = matchRole(match, viewerId);
  const race = new Date(startsAt);
  const confirm = role === "crew" && match.status === "accepted" && localDate(now) === localDate(race);
  const record = role === "skipper" && (match.status === "accepted" || match.status === "confirmed") && now.getTime() > race.getTime();
  return { confirm, record };
}

/** The refusal setMatchStatus sends back, as the page explains it. */
export function explainStatusRefusal(reason: string): string {
  switch (reason) {
    case "status-refused":
      return "That could not be recorded. The crew confirms on the race day; the skipper records Sailed or Did not show after the start.";
    default:
      return "That could not be saved.";
  }
}

/** The refusals acceptAnswer can send back, as the page explains them. */
export function explainAcceptRefusal(reason: string): string {
  switch (reason) {
    case "matched":
      return "This need already has a match — the first acceptance stands.";
    case "refused":
      return "The database refused that. Only the boat's owner can accept, and only someone with a live answer on this post.";
    default:
      return "That could not be saved.";
  }
}
