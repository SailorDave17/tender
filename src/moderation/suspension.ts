/**
 * What a suspended person is told (story #36 AC 4).
 *
 * The refusal itself is the database's: 0023 adds one restrictive policy per write the issue
 * names — a post, an answer (and answering again), a message — so a suspended person's write is
 * refused however it arrives. This module is only the sentence, kept in one place so the board's
 * notice at sign-in and the thread's closed send box say the same thing.
 *
 * "Suspension hides nothing already written": nothing here filters a read. The person still
 * reads the board, their posts, their threads; the notice says so, because a suspended person who
 * finds their own old messages still showing should not read that as the suspension failing.
 */

export const SUSPENDED_NOTE =
  "Your account is suspended by the club admin: you can still read everything, but you cannot post, answer or send messages.";

/** The suspension row as the signed-in person reads their own (0023: self or admin). */
export type SuspensionRow = { person_id: string; suspended_at: string };

/**
 * Who is suspended, keyed by person id, from the rows the caller could read. For a member that is
 * at most their own row; for the admin it is everyone's.
 */
export function suspendedSince(rows: readonly SuspensionRow[] | null | undefined): Map<string, string> {
  return new Map((rows ?? []).map((r) => [r.person_id, r.suspended_at]));
}
