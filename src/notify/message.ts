import type { Message, Transport } from "@/email/send";
import type { PushTarget, PushTransport } from "@/push/send";
import { messagePush } from "@/push/payload";
import { whenLabel } from "@/dates/race-date";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * notifyMessage(messageId): tell the counterparty that something was said in the thread
 * (story #35 AC 3, AC 4). Workflow 7's delivery half — the thread page is the record, this is
 * what makes somebody look at it.
 *
 * TWO CHANNELS, TWO RULES, the same split notifyAnswer() established and for the same reasons:
 *
 *   - PUSH goes on every message, unsuppressed. It costs nothing, and the payload's tag
 *     (`thread-<matchId>`) collapses a burst into ONE notification on the device whose count
 *     updates — the push service does the rationing for us, per device, for free.
 *   - EMAIL is rationed against Resend's 100/day: a message within MESSAGE_EMAIL_WINDOW_MS of
 *     the last message email TO THAT COUNTERPARTY is suppressed, logged `message_suppressed`.
 *     Suppress, never queue — there is no scheduler to flush a queue.
 *
 * AND A BACKSTOP, which is the part that is NOT notifyAnswer()'s shape (owner decision
 * 2026-09-17). The window is anchored on the last email SENT, and a suppressed message sends no
 * email — so the anchor does not move when a message is suppressed. An author posting just
 * inside the window repeatedly would therefore email the counterparty ONCE and never again,
 * with every single step obeying the rule: a bound that is true of every step and false of the
 * walk (cairn: a-per-step-bound-is-unbounded-across-steps-2026-09-08). Push still fires, but
 * AC 3's whole premise is a counterparty who has no push installed. So after
 * MESSAGE_SUPPRESS_LIMIT consecutive suppressions to that counterparty, the next message emails
 * regardless of the window, and the run resets.
 *
 * The window is measured from the last SUCCESSFUL message email (error null), so a send the
 * provider refused does not start a quiet ten minutes — the next message retries.
 *
 * The recipient is always the counterparty, never the author: a person is not notified about
 * their own message. Which of the two parties that is comes from the match, not from the
 * caller, so a forged call cannot redirect a notification.
 *
 * Pure over its inputs: the store, both transports and `now` are injected, so the tests run
 * against an in-memory store with fakes and a pinned clock (AC 4's fake clock).
 */

/** One message email attempted — accepted or refused; `error` says which (AC 3). */
export const KIND_MESSAGE = "message";
/** A message inside the window: no email sent, this row is the record (AC 4). */
export const KIND_MESSAGE_SUPPRESSED = "message_suppressed";
/** One attempted message push, per device — same shape as rung_push (story #29). */
export const KIND_MESSAGE_PUSH = "message_push";
/** A subscription the push service retired, found while pushing. Row deleted. */
export const KIND_MESSAGE_PUSH_GONE = "message_push_gone";

/**
 * How long after a message email the next one to the same counterparty is suppressed. The
 * issue names ten minutes and nothing has re-derived it: a recorded default protecting the
 * 100/day cap, not a decision.
 *
 * The band this has to sit in, stated so a future change is judged rather than nudged: below
 * about two minutes the suppression is decoration — a rapid exchange still emails on nearly
 * every line — and above about thirty a genuine second message goes unnoticed for half an hour,
 * which is the failure the thread exists to prevent ("which dock, what time").
 */
export const MESSAGE_EMAIL_WINDOW_MS = 10 * 60 * 1000;

/**
 * How many consecutive suppressions to one counterparty before an email is forced through.
 * Three: on a rapid exchange that is roughly one email per four messages, and on a steady drip
 * just inside the window the counterparty hears again after about thirty-six minutes.
 */
export const MESSAGE_SUPPRESS_LIMIT = 3;

/** A message as the dispatcher needs it: who wrote it, in which thread, and on what post. */
export type MessageRow = {
  id: string;
  matchId: string;
  authorId: string;
  body: string;
  /** The post the match was formed on — what notification_log keys every row by. */
  postId: string;
};

export type MessageParties = { skipperId: string; crewId: string };

export interface MessageStore {
  /** The message being notified about, or null when it is gone. */
  message(messageId: string): Promise<MessageRow | null>;
  /** The two parties to the match the message is in, or null when the match is gone. */
  parties(matchId: string): Promise<MessageParties | null>;
  /** The post as the email's copy reads it — boat, class, race date. */
  post(postId: string): Promise<RungPost | null>;
  /** The author's display name, for the email's subject. Null when the row is gone. */
  name(personId: string): Promise<string | null>;
  /** The recipient's contact email, or null when they have no contact row. */
  email(personId: string): Promise<string | null>;
  /**
   * When the last SUCCESSFUL message email to this person in this thread was sent (error null),
   * or null if never. The window's anchor.
   */
  lastMessageEmailAt(matchId: string, personId: string): Promise<Date | null>;
  /**
   * How many `message_suppressed` rows this person has in this thread SINCE that last
   * successful email — the consecutive run the backstop counts. Zero when none.
   */
  suppressedSince(matchId: string, personId: string, since: Date | null): Promise<number>;
  /** Every push subscription the person has. Empty when none. */
  pushTargets(personId: string): Promise<(PushTarget & { id: string })[]>;
  /** Remove a subscription the push service has retired. By row id, as the rung store does. */
  deleteSubscription(id: string): Promise<void>;
  /** Email sends attempted so far in the day `now` falls in, all kinds — the cap's count. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: LogEntry): Promise<void>;
}

export type MessageNotifyDeps = {
  store: MessageStore;
  transport: Transport;
  /** Web push, when configured — optional for the same reason as DispatchDeps.push (#29). */
  push?: PushTransport;
  now: Date;
  /** The site's origin, for the link in the email. */
  siteUrl: string;
};

export type MessageNotifyResult = {
  emailed: boolean;
  suppressed: boolean;
  /** True when the email went out because of the backstop rather than the window being clear. */
  forced: boolean;
  skippedCap: boolean;
  pushed: number;
  pushFailed: number;
  pruned: number;
};

/** What the counterparty reads. Exported so the copy is tested, not so anything else sends it. */
export function messageEmail(
  post: RungPost,
  authorName: string,
  to: string,
  siteUrl: string,
  more: number,
): Message {
  const when = whenLabel(post.startsAt);
  // `more` is how many messages were suppressed before this one — only ever non-zero on a
  // forced send, where saying "3 more" is the difference between a useful email and one that
  // understates what is waiting.
  const extra = more > 0 ? ` (and ${more} more ${more === 1 ? "message" : "messages"})` : "";
  return {
    to,
    subject: `${authorName} messaged you: ${post.boatName}, ${when}`,
    text: [
      `${authorName} sent you a message${extra} about ${post.boatName} (${post.boatClass}), ${post.dateTitle}, ${when}.`,
      ``,
      `Read it and reply here: ${siteUrl}/post/${post.id}/thread`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

export async function notifyMessage(messageId: string, deps: MessageNotifyDeps): Promise<MessageNotifyResult | null> {
  const { store, transport, push, now, siteUrl } = deps;
  const message = await store.message(messageId);
  if (!message) return null;
  const parties = await store.parties(message.matchId);
  if (!parties) return null;

  // The recipient is the OTHER party, taken from the match rather than from the caller. An
  // author who is somehow neither party notifies nobody rather than notifying both.
  const to =
    message.authorId === parties.skipperId
      ? parties.crewId
      : message.authorId === parties.crewId
        ? parties.skipperId
        : null;
  if (to === null) return null;

  const post = await store.post(message.postId);
  if (!post) return null;

  const result: MessageNotifyResult = {
    emailed: false,
    suppressed: false,
    forced: false,
    skippedCap: false,
    pushed: 0,
    pushFailed: 0,
    pruned: 0,
  };

  // Push first, unsuppressed — instant and free; the tag collapses a burst on the device.
  if (push) {
    const authorName = (await store.name(message.authorId)) ?? "Your counterparty";
    for (const target of await store.pushTargets(to)) {
      const outcome = await push.send(target, messagePush(post, authorName, message.body));
      if (outcome.ok) {
        result.pushed += 1;
        await store.log({ kind: KIND_MESSAGE_PUSH, channel: "push", personId: to, toEmail: null, postId: post.id, providerId: target.endpoint, error: null });
      } else if (outcome.gone) {
        result.pruned += 1;
        await store.log({ kind: KIND_MESSAGE_PUSH_GONE, channel: "push", personId: to, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
        await store.deleteSubscription(target.id);
      } else {
        result.pushFailed += 1;
        await store.log({ kind: KIND_MESSAGE_PUSH, channel: "push", personId: to, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
      }
    }
  }

  // Email second, behind the window — unless the backstop is due (AC 4).
  const last = await store.lastMessageEmailAt(message.matchId, to);
  const inWindow = last !== null && now.getTime() - last.getTime() < MESSAGE_EMAIL_WINDOW_MS;
  // The run counted since the last successful email, which is exactly the anchor above: a
  // successful send both moves the anchor and ends the run, so the two can never disagree.
  //
  // The `inWindow ?` gate is REDUNDANT and kept for legibility, which is worth saying because a
  // mutation pass will find it and a reader should not have to re-derive the answer. Removing it
  // reddens nothing (*measured*, 0 of 21) — not because the branch is untested but because the
  // two forms are equivalent: `suppressedSince` counts from the anchor, and any successful send
  // moves the anchor past every suppression before it, so outside the window the count is
  // already 0. It is an invalid mutation rather than a coverage hole (cairn: the #118 rule that a
  // mutation which cannot change behaviour is not a finding), and the gate stays because
  // "outside the window, nothing is owed" is the rule this code is expressing.
  const suppressedRun = inWindow ? await store.suppressedSince(message.matchId, to, last) : 0;
  const forced = inWindow && suppressedRun >= MESSAGE_SUPPRESS_LIMIT;

  if (inWindow && !forced) {
    result.suppressed = true;
    await store.log({ kind: KIND_MESSAGE_SUPPRESSED, channel: "email", personId: to, toEmail: null, postId: post.id, providerId: null, error: null });
    return result;
  }
  result.forced = forced;

  // The daily cap is checked after the window, so a message that would have been suppressed
  // anyway does not spend a cap slot deciding that.
  if ((await store.emailsSentToday(now)) >= EMAIL_SKIP_AT) {
    result.skippedCap = true;
    result.forced = false;
    await store.log({ kind: KIND_MESSAGE_SUPPRESSED, channel: "email", personId: to, toEmail: null, postId: post.id, providerId: null, error: "daily cap" });
    return result;
  }

  const address = await store.email(to);
  if (address === null) {
    // No contact row: log it and leave the message standing. Nothing here undoes the insert.
    await store.log({ kind: KIND_MESSAGE, channel: "email", personId: to, toEmail: null, postId: post.id, providerId: null, error: "no contact email" });
    return result;
  }

  const authorName = (await store.name(message.authorId)) ?? "Your counterparty";
  try {
    const { id } = await transport.send(messageEmail(post, authorName, address, siteUrl, suppressedRun));
    result.emailed = true;
    await store.log({ kind: KIND_MESSAGE, channel: "email", personId: to, toEmail: address, postId: post.id, providerId: id, error: null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await store.log({ kind: KIND_MESSAGE, channel: "email", personId: to, toEmail: address, postId: post.id, providerId: null, error });
  }
  return result;
}
