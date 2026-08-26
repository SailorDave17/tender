/**
 * What a crew may do about a post, as a pure decision over an injected `now` (story #20 AC 2,
 * AC 3). The page renders the state; the Server Action decides it again before writing,
 * because a disabled button is a courtesy and not a guard; the database decides the
 * availability and open-post halves a third time (0007's can_answer).
 *
 * The past-date rule lives only here, as it does for availability (src/availability/rules.ts):
 * a policy would need now(), and a rule about the present reads better at this level.
 */

import { isPast } from "@/availability/rules";

export type AnswerState =
  /** The crew has an un-withdrawn answer on this post: offer Withdraw. */
  | "answered"
  /** Available for the date, post open, date ahead: offer I can. */
  | "can"
  /** Not marked available for the date: I can is disabled, with a link to mark it first. */
  | "unavailable"
  /** The post is closed — nothing to answer. */
  | "closed"
  /** The race has started — too late to answer. */
  | "past";

export function answerState(
  post: { closed_at: string | null },
  date: { starts_at: string | Date },
  viewer: { answered: boolean; available: boolean },
  now: Date,
): AnswerState {
  if (post.closed_at !== null) return "closed";
  if (isPast(date.starts_at, now)) return "past";
  if (viewer.answered) return "answered";
  if (!viewer.available) return "unavailable";
  return "can";
}

/** The refusals the Server Action can send back, as the page explains them. */
export type AnswerRefusal = "closed" | "past" | "not-available" | "refused";

export function explainAnswerRefusal(reason: string): string {
  switch (reason) {
    case "closed":
      return "That need has been closed.";
    case "past":
      return "That race day has already started.";
    case "not-available":
      return "Mark yourself available for that day on the board first.";
    case "refused":
      return "The database refused that. You can answer an open need only on a day you have marked available.";
    default:
      return "That could not be saved.";
  }
}
