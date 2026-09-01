import type { Message, Transport } from "@/email/send";
import { whenLabel } from "@/dates/race-date";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * notifyMatch(postId): email both parties the moment a match forms (story #33) — the skipper
 * and the accepted crew each get one email naming the other person, the boat, the race and the
 * post page, where the match panel shows contact for both (story #21).
 *
 * The link is /post/[id], not a match URL: no match page exists — the match view is
 * MatchPanel on the post page — so the issue's filed "/match/[id]" named a route #21 never
 * built (owner decision at pickup, 2026-09-01; a match page is the thread story's to design).
 *
 * EMAIL ONLY, no push: the issue asks for email, and unlike an answer (perishable — "accept
 * before they change their mind") a match is a done deal both parties will find on the page.
 *
 * The cap rule is dispatchPending()'s, applied per send: at or past EMAIL_SKIP_AT the send is
 * skipped and logged as match_skipped_cap, and the match stands either way (AC 3) — the match
 * row was written by accept_answer() before this runs, and nothing here can or does undo it.
 * One below the cap the first email (the skipper's) is sent and the second skipped, the same
 * per-recipient rule the rung dispatch applies; the pair is not atomic, because the page shows
 * both parties the contact regardless and a deliverable email beats a symmetrically absent one.
 *
 * A transport failure is logged with its error and never thrown past the loop: the other
 * party's email is still attempted, and the caller (notifyMatchLive) swallows anyway (AC 2).
 *
 * Unlike notifyRung(), a CLOSED post is expected here: accept_answer() closes the post in the
 * same transaction that writes the match, so by the time this runs closed_at is always set.
 * There is no closed-post guard, on purpose.
 *
 * Pure over its inputs: the store, the transport and `now` are injected, so the unit tests run
 * against an in-memory store with a fake transport and count recipients exactly.
 */

/** One match email attempted — accepted or refused; `error` says which (AC 1, AC 2). */
export const KIND_MATCH = "match";
/** A send skipped at the daily cap: no email, this row is the record, the match stands (AC 3). */
export const KIND_MATCH_SKIPPED_CAP = "match_skipped_cap";

export type MatchParties = { skipperId: string; crewId: string };

export interface MatchStore {
  /** The post as rungMessage() reads it. closed_at is set — accept_answer() closed it. */
  post(postId: string): Promise<RungPost | null>;
  /** The match on the post, or null when none formed (the accept raced or failed). */
  matchByPost(postId: string): Promise<MatchParties | null>;
  /** The person's display name, or null when the row is gone (the deletion story's case). */
  name(personId: string): Promise<string | null>;
  /** The person's contact email, or null when they have no contact row. */
  email(personId: string): Promise<string | null>;
  /** Email sends attempted so far in the day `now` falls in, all kinds. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: LogEntry): Promise<void>;
}

export type MatchNotifyDeps = {
  store: MatchStore;
  transport: Transport;
  now: Date;
  /** The site's origin, for the link in the email. */
  siteUrl: string;
};

export type MatchNotifyResult = { sent: number; skippedCap: number; failed: number };

/** What each party reads. Exported so the copy is tested, not so anything else sends it. */
export function matchMessage(post: RungPost, otherName: string, to: string, siteUrl: string): Message {
  const when = whenLabel(post.startsAt);
  return {
    to,
    subject: `Matched: ${post.boatName} (${post.boatClass}), ${when}`,
    text: [
      `You are matched with ${otherName} on ${post.boatName} (${post.boatClass}) for ${post.dateTitle}, ${when}.`,
      ``,
      `Contact details for both of you are on the post: ${siteUrl}/post/${post.id}`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

export async function notifyMatch(postId: string, deps: MatchNotifyDeps): Promise<MatchNotifyResult | null> {
  const { store, transport, now, siteUrl } = deps;
  const post = await store.post(postId);
  if (!post) return null;
  const match = await store.matchByPost(postId);
  if (!match) return null;

  const result: MatchNotifyResult = { sent: 0, skippedCap: 0, failed: 0 };
  // Skipper first, then crew — the order the cap's per-send rule falls on when one send is left.
  const pair = [
    { personId: match.skipperId, otherId: match.crewId },
    { personId: match.crewId, otherId: match.skipperId },
  ];

  let sentToday = await store.emailsSentToday(now);
  for (const p of pair) {
    const to = await store.email(p.personId);
    if (to === null) {
      // No contact row: say so in the log rather than throwing — the other party's email and
      // the match itself stand, and the page shows contact regardless (answer.ts's rule).
      result.failed += 1;
      await store.log({ kind: KIND_MATCH, channel: "email", personId: p.personId, toEmail: null, postId: post.id, providerId: null, error: "no contact email" });
      continue;
    }
    if (sentToday >= EMAIL_SKIP_AT) {
      result.skippedCap += 1;
      await store.log({ kind: KIND_MATCH_SKIPPED_CAP, channel: "email", personId: p.personId, toEmail: to, postId: post.id, providerId: null, error: null });
      continue;
    }
    const otherName = (await store.name(p.otherId)) ?? "your counterparty";
    sentToday += 1; // counted whether or not the provider accepts it: an attempt is what the cap is about
    try {
      const { id } = await transport.send(matchMessage(post, otherName, to, siteUrl));
      result.sent += 1;
      await store.log({ kind: KIND_MATCH, channel: "email", personId: p.personId, toEmail: to, postId: post.id, providerId: id, error: null });
    } catch (e) {
      result.failed += 1;
      const error = e instanceof Error ? e.message : String(e);
      await store.log({ kind: KIND_MATCH, channel: "email", personId: p.personId, toEmail: to, postId: post.id, providerId: null, error });
    }
  }
  return result;
}
