/**
 * The admin's list of match threads, by last activity (story #36 AC 1).
 *
 * Pure, over rows the page has already read as the signed-in admin, so the ordering — the one
 * decision on the list screen — is testable without a database. The reads themselves run through
 * RLS: 0023's `message_read_admin` is what hands the admin messages in threads they are not a
 * party to, and a non-admin reaching the same code would get their own threads at most.
 *
 * WHAT "LAST ACTIVITY" MEANS. The newest message in the thread, or — for a thread nobody has
 * written in yet — the moment the match was accepted, since that is when the thread opened
 * (charter workflow 5: "a match thread opens"). Every match has a thread, so a silent one is
 * listed rather than hidden: the admin is asked to be in reach of the surface where strangers
 * talk, and "nothing has been said here" is part of that picture. Removed messages still count
 * as activity — something was said, and it is the thing the admin most needs to find again.
 */

export type ThreadMatch = {
  id: string;
  post_id: string;
  /** Null once that party deleted their account (0027). */
  skipper_id: string | null;
  crew_id: string | null;
  accepted_at: string;
};

export type ThreadMessage = { match_id: string; created_at: string; removed_at: string | null };

export type ThreadSummary = ThreadMatch & {
  /** Newest message's created_at, or accepted_at when the thread is empty. */
  lastActivity: string;
  messages: number;
  removed: number;
};

export function threadsByActivity(
  matches: readonly ThreadMatch[],
  messages: readonly ThreadMessage[],
): ThreadSummary[] {
  const byMatch = new Map<string, { last: number; n: number; removed: number }>();
  for (const m of messages) {
    const t = new Date(m.created_at).getTime();
    const s = byMatch.get(m.match_id) ?? { last: -Infinity, n: 0, removed: 0 };
    s.last = Math.max(s.last, t);
    s.n += 1;
    if (m.removed_at) s.removed += 1;
    byMatch.set(m.match_id, s);
  }
  return matches
    .map((match) => {
      const s = byMatch.get(match.id);
      const last = s ? new Date(s.last).toISOString() : match.accepted_at;
      return { ...match, lastActivity: last, messages: s?.n ?? 0, removed: s?.removed ?? 0 };
    })
    .sort(
      (a, b) =>
        new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime() || a.id.localeCompare(b.id),
    );
}
