import type { Message, Transport } from "@/email/send";
import type { PushTarget, PushTransport } from "@/push/send";
import { answerPush } from "@/push/payload";
import { whenLabel } from "@/dates/race-date";
import type { LogEntry, RungPost } from "./rung";

/**
 * notifyAnswer(postId): tell the post's skipper that crew have answered (story #24) — the
 * other half of workflow 5, and the notification whose LATENCY matters most: the story's whole
 * premise is "accept before they change their mind".
 *
 * TWO CHANNELS, TWO RULES, AND THEY DIFFER ON PURPOSE (owner decision at pickup, 2026-08-30 —
 * the issue's AC 3 was written before #29 shipped push, so "a push transport later added" had
 * already happened by the time this was built):
 *
 *   - PUSH goes on every answer, unsuppressed. It costs nothing, and the payload's tag
 *     (`post-<id>-answer`) means a device shows ONE notification whose count updates rather
 *     than a stack — the push service does the suppression for us, per device, for free.
 *   - EMAIL is rationed (Resend's 100/day), so a second answer within ANSWER_EMAIL_WINDOW_MS
 *     of the last answer email is suppressed: no send, one `answer_suppressed` log row.
 *     Suppress, never queue — there is no scheduler to flush a queue (the tick is #26's, and
 *     it sweeps posts, not people). The skipper still got the push, and the post page shows
 *     every answer; the next answer past the window emails the then-current count.
 *
 * The window is measured from the last SUCCESSFUL answer email for the post (error null), so a
 * send the provider refused does not start a quiet quarter-hour — the next answer retries.
 *
 * There is no per-recipient ledger here, unlike notifyRung()'s suggestion queue: the recipient
 * is one person the post row already names, and "notify on every event, suppressed by the
 * window" is the whole delivery rule. A failed email is logged with its error and simply not
 * retried until the next answer — the board remains the record (ADR 007).
 *
 * Pure over its inputs: store, both transports and `now` are injected (AC 3 — the same call
 * site carries every transport; AC 2 — the tests pin the clock).
 */

/** One answer email attempted — accepted or refused; `error` says which (AC 1). */
export const KIND_ANSWER = "answer";
/** An answer inside the window: no email sent, this row is the record (AC 2). */
export const KIND_ANSWER_SUPPRESSED = "answer_suppressed";
/** One attempted answer push, per device — same shape as rung_push (story #29). */
export const KIND_ANSWER_PUSH = "answer_push";
/** A subscription the push service retired, found while pushing the skipper. Row deleted. */
export const KIND_ANSWER_PUSH_GONE = "answer_push_gone";

/**
 * How long after an answer email the next one is suppressed. A recorded default protecting the
 * 100/day cap, not a decision — the issue names 15 minutes and nothing has re-derived it.
 */
export const ANSWER_EMAIL_WINDOW_MS = 15 * 60 * 1000;

/** The post as this story needs it: everything rungMessage() reads, plus whose boat it is. */
export type AnswerPost = RungPost & { skipperId: string };

export interface AnswerStore {
  post(postId: string): Promise<AnswerPost | null>;
  /** Un-withdrawn answers on the post, right now — the N in "N crew answered". */
  liveAnswers(postId: string): Promise<number>;
  /** When the last answer email for this post was SENT (error null), or null if never. */
  lastAnswerEmailAt(postId: string): Promise<Date | null>;
  /** The person's contact email, or null when they have no contact row. */
  email(personId: string): Promise<string | null>;
  /** Every push subscription the person has. Empty when none. */
  pushTargets(personId: string): Promise<(PushTarget & { id: string })[]>;
  /** Remove a subscription the push service has retired. By row id, as the rung store does. */
  deleteSubscription(id: string): Promise<void>;
  log(entry: LogEntry): Promise<void>;
}

export type AnswerNotifyDeps = {
  store: AnswerStore;
  transport: Transport;
  /** Web push, when configured — optional for the same reason as DispatchDeps.push (#29). */
  push?: PushTransport;
  now: Date;
  /** The site's origin, for the link in the email. */
  siteUrl: string;
};

export type AnswerNotifyResult = {
  /** The live answer count the notification carried. */
  count: number;
  emailed: boolean;
  suppressed: boolean;
  pushed: number;
  pushFailed: number;
  pruned: number;
};

/** What the skipper reads. Exported so the copy is tested, not so anything else sends it. */
export function answerMessage(post: RungPost, count: number, to: string, siteUrl: string): Message {
  const when = whenLabel(post.startsAt);
  return {
    to,
    subject: `${count} crew answered: ${post.boatName}, ${when}`,
    text: [
      `${count} crew answered your post for ${post.boatName} (${post.boatClass}), ${post.dateTitle}, ${when}.`,
      ``,
      `Accept one here: ${siteUrl}/post/${post.id}`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

export async function notifyAnswer(postId: string, deps: AnswerNotifyDeps): Promise<AnswerNotifyResult | null> {
  const { store, transport, push, now, siteUrl } = deps;
  const post = await store.post(postId);
  if (!post || post.closedAt !== null) return null;

  // Read the count once and tell both channels the same number. Zero means the answer was
  // withdrawn between the action's write and this read — nothing to say.
  const count = await store.liveAnswers(postId);
  if (count === 0) return null;

  const result: AnswerNotifyResult = { count, emailed: false, suppressed: false, pushed: 0, pushFailed: 0, pruned: 0 };

  // Push first, unsuppressed — instant and free; the tag collapses repeats on the device.
  if (push) {
    for (const target of await store.pushTargets(post.skipperId)) {
      const outcome = await push.send(target, answerPush(post, count));
      if (outcome.ok) {
        result.pushed += 1;
        await store.log({ kind: KIND_ANSWER_PUSH, channel: "push", personId: post.skipperId, toEmail: null, postId: post.id, providerId: target.endpoint, error: null });
      } else if (outcome.gone) {
        result.pruned += 1;
        await store.log({ kind: KIND_ANSWER_PUSH_GONE, channel: "push", personId: post.skipperId, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
        await store.deleteSubscription(target.id);
      } else {
        result.pushFailed += 1;
        await store.log({ kind: KIND_ANSWER_PUSH, channel: "push", personId: post.skipperId, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
      }
    }
  }

  // Email second, behind the window (AC 2).
  const last = await store.lastAnswerEmailAt(post.id);
  if (last !== null && now.getTime() - last.getTime() < ANSWER_EMAIL_WINDOW_MS) {
    result.suppressed = true;
    await store.log({ kind: KIND_ANSWER_SUPPRESSED, channel: "email", personId: post.skipperId, toEmail: null, postId: post.id, providerId: null, error: null });
    return result;
  }

  const to = await store.email(post.skipperId);
  if (to === null) {
    // A skipper with no contact row cannot be emailed; say so in the log rather than throwing —
    // the answer row already stands and the push (above) may well have landed.
    await store.log({ kind: KIND_ANSWER, channel: "email", personId: post.skipperId, toEmail: null, postId: post.id, providerId: null, error: "no contact email" });
    return result;
  }

  try {
    const { id } = await transport.send(answerMessage(post, count, to, siteUrl));
    result.emailed = true;
    await store.log({ kind: KIND_ANSWER, channel: "email", personId: post.skipperId, toEmail: to, postId: post.id, providerId: id, error: null });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await store.log({ kind: KIND_ANSWER, channel: "email", personId: post.skipperId, toEmail: to, postId: post.id, providerId: null, error });
  }
  return result;
}
