import type { Message, Transport } from "@/email/send";
import type { PushTarget, PushTransport } from "@/push/send";
import { confirmPush, confirmedPush } from "@/push/payload";
import { whenLabel } from "@/dates/race-date";
import type { MorningMatch } from "@/engine/morningOf";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * The two notifications of the race morning (story #37 AC 2, AC 3) — workflow 6's delivery half.
 *
 *   remindCrew(match)          the tick's morning-of pass asks the crew to confirm: a push if
 *                              they have a device, an email with a Confirm link, and
 *                              `match.reminded_at` set AFTER the attempt.
 *   notifyConfirmed(matchId)   the Confirm action tells the skipper: a push and an email, through
 *                              the same transports the rest of the app uses.
 *
 * TWO CHANNELS, ONE RULE EACH, the split notifyAnswer() established: push is instant and free and
 * goes whenever a device exists; email is rationed against Resend's 100/day and is skipped at the
 * cap, logged, never queued — there is no scheduler to flush a queue, and the morning-of pass IS
 * the scheduler.
 *
 * `reminded_at` IS SET ONCE, AFTER THE ATTEMPT, WHATEVER HAPPENED (owner decision at pickup,
 * 2026-09-18). The rung dispatch leaves its ledger column NULL on a refusal so the clock retries;
 * this deliberately does not, because the clock that would retry runs every fifteen minutes on
 * the one day the email cap matters most, and the cap clears at UTC midnight — 8 pm in Ohio,
 * after the race. A refused send is in notification_log with its error; a cap skip is
 * `morning_of_skipped_cap`; the push, which costs nothing, went regardless. What is lost is one
 * courtesy email on a morning the provider was down, and the crew still sees the match page.
 *
 * The link is /post/[id], not /match/[id]: no match route exists, the match view is MatchPanel
 * on the post page, and #33 and #35 resolved the same filed-but-unbuilt route the same way.
 *
 * Pure over its inputs: the store, both transports and `now` are injected.
 */

/** One reminder email attempted — accepted or refused; `error` says which (AC 2). */
export const KIND_MORNING_OF = "morning_of";
/** A reminder email skipped at the daily cap: no send, this row is the record. */
export const KIND_MORNING_OF_SKIPPED_CAP = "morning_of_skipped_cap";
/** One attempted reminder push, per device. */
export const KIND_MORNING_OF_PUSH = "morning_of_push";
/** A subscription the push service retired, found while reminding. Row deleted. */
export const KIND_MORNING_OF_PUSH_GONE = "morning_of_push_gone";

/** One "crew confirmed" email to the skipper attempted (AC 3). */
export const KIND_CONFIRMED = "confirmed";
export const KIND_CONFIRMED_SKIPPED_CAP = "confirmed_skipped_cap";
export const KIND_CONFIRMED_PUSH = "confirmed_push";
export const KIND_CONFIRMED_PUSH_GONE = "confirmed_push_gone";

export type ConfirmMatch = { id: string; postId: string; skipperId: string; crewId: string; status: string };

export interface ConfirmStore {
  /** The match by id, or null when gone. */
  match(matchId: string): Promise<ConfirmMatch | null>;
  /** The post as rungMessage() reads it. closed_at is set — a matched post is closed. */
  post(postId: string): Promise<RungPost | null>;
  /** The person's display name, or null when the row is gone. */
  name(personId: string): Promise<string | null>;
  /** The person's contact email, or null when they have no contact row. */
  email(personId: string): Promise<string | null>;
  /** Every push subscription the person has. Empty when none. */
  pushTargets(personId: string): Promise<(PushTarget & { id: string })[]>;
  /** Remove a subscription the push service has retired. By row id. */
  deleteSubscription(id: string): Promise<void>;
  /** Email sends attempted so far in the day `now` falls in, all kinds. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: LogEntry): Promise<void>;
  /** Stamp `match.reminded_at` (0021). Once; the pass never hands the same match back. */
  markReminded(matchId: string, at: Date): Promise<void>;
}

export type ConfirmDeps = {
  store: ConfirmStore;
  transport: Transport;
  /** Web push, when configured — optional for the same reason as DispatchDeps.push (#29). */
  push?: PushTransport;
  now: Date;
  /** The site's origin, for the link in the email. */
  siteUrl: string;
};

export type ConfirmNotifyResult = {
  emailed: boolean;
  skippedCap: boolean;
  failed: boolean;
  pushed: number;
  pushFailed: number;
  pruned: number;
};

/** What the crew reads on the race morning. Exported so the copy is tested. */
export function reminderMessage(post: RungPost, to: string, siteUrl: string): Message {
  const when = whenLabel(post.startsAt);
  return {
    to,
    subject: `Confirm for today: ${post.boatName}, ${when}`,
    text: [
      `It's race day. You are crewing ${post.boatName} (${post.boatClass}) for ${post.dateTitle}, ${when}.`,
      ``,
      `Please confirm you're sailing so the skipper knows by breakfast: ${siteUrl}/post/${post.id}`,
      ``,
      `If you can't make it, tell the skipper in the thread on that page.`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

/** What the skipper reads when the crew confirms. Exported so the copy is tested. */
export function confirmedMessage(post: RungPost, crewName: string, to: string, siteUrl: string): Message {
  const when = whenLabel(post.startsAt);
  return {
    to,
    subject: `${crewName} confirmed: ${post.boatName}, ${when}`,
    text: [
      `${crewName} confirmed for ${post.boatName} (${post.boatClass}), ${post.dateTitle}, ${when}.`,
      ``,
      `The match is here: ${siteUrl}/post/${post.id}`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

type Kinds = { push: string; pushGone: string; email: string; skippedCap: string };

/**
 * The shared delivery: push every device, then one email under the cap, each outcome logged.
 * `personId` is the recipient; the payload and the message are the caller's, because the two
 * notifications differ only in who reads what.
 */
async function deliver(
  personId: string,
  post: RungPost,
  payload: ReturnType<typeof confirmPush>,
  message: (to: string) => Message,
  kinds: Kinds,
  deps: ConfirmDeps,
): Promise<ConfirmNotifyResult> {
  const { store, transport, push, now } = deps;
  const result: ConfirmNotifyResult = { emailed: false, skippedCap: false, failed: false, pushed: 0, pushFailed: 0, pruned: 0 };

  // Push first, unsuppressed — instant and free; the payload's tag collapses repeats per device.
  if (push) {
    for (const target of await store.pushTargets(personId)) {
      const outcome = await push.send(target, payload);
      if (outcome.ok) {
        result.pushed += 1;
        await store.log({ kind: kinds.push, channel: "push", personId, toEmail: null, postId: post.id, providerId: target.endpoint, error: null });
      } else if (outcome.gone) {
        result.pruned += 1;
        await store.log({ kind: kinds.pushGone, channel: "push", personId, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
        await store.deleteSubscription(target.id);
      } else {
        result.pushFailed += 1;
        await store.log({ kind: kinds.push, channel: "push", personId, toEmail: null, postId: post.id, providerId: target.endpoint, error: outcome.error });
      }
    }
  }

  const to = await store.email(personId);
  if (to === null) {
    // No contact row: say so in the log rather than throwing — the push may have gone, and the
    // page shows the match regardless (answer.ts's rule).
    result.failed = true;
    await store.log({ kind: kinds.email, channel: "email", personId, toEmail: null, postId: post.id, providerId: null, error: "no contact email" });
    return result;
  }
  if ((await store.emailsSentToday(now)) >= EMAIL_SKIP_AT) {
    result.skippedCap = true;
    await store.log({ kind: kinds.skippedCap, channel: "email", personId, toEmail: to, postId: post.id, providerId: null, error: null });
    return result;
  }
  try {
    const { id } = await transport.send(message(to));
    result.emailed = true;
    await store.log({ kind: kinds.email, channel: "email", personId, toEmail: to, postId: post.id, providerId: id, error: null });
  } catch (e) {
    result.failed = true;
    const error = e instanceof Error ? e.message : String(e);
    await store.log({ kind: kinds.email, channel: "email", personId, toEmail: to, postId: post.id, providerId: null, error });
  }
  return result;
}

const MORNING_KINDS: Kinds = {
  push: KIND_MORNING_OF_PUSH,
  pushGone: KIND_MORNING_OF_PUSH_GONE,
  email: KIND_MORNING_OF,
  skippedCap: KIND_MORNING_OF_SKIPPED_CAP,
};

const CONFIRMED_KINDS: Kinds = {
  push: KIND_CONFIRMED_PUSH,
  pushGone: KIND_CONFIRMED_PUSH_GONE,
  email: KIND_CONFIRMED,
  skippedCap: KIND_CONFIRMED_SKIPPED_CAP,
};

/**
 * Ask the crew to confirm (AC 2). The pass has already decided the reminder is due; this sends
 * and then marks — the mark is last so a store that cannot log leaves the match un-reminded for
 * the next tick rather than marked and unsent.
 */
export async function remindCrew(match: MorningMatch, deps: ConfirmDeps): Promise<ConfirmNotifyResult> {
  const { store, now, siteUrl } = deps;
  const post = match.post;
  const result = await deliver(match.crewId, post, confirmPush(post), (to) => reminderMessage(post, to, siteUrl), MORNING_KINDS, deps);
  await store.markReminded(match.id, now);
  return result;
}

/**
 * Tell the skipper the crew confirmed (AC 3). Null when the match is gone or is not confirmed —
 * the action calls this only after set_match_status() returned 'confirmed', and reading the
 * status back rather than trusting the caller is what keeps a crafted call from emailing a
 * skipper about a confirmation that did not happen.
 */
export async function notifyConfirmed(matchId: string, deps: ConfirmDeps): Promise<ConfirmNotifyResult | null> {
  const { store, siteUrl } = deps;
  const match = await store.match(matchId);
  if (!match || match.status !== "confirmed") return null;
  const post = await store.post(match.postId);
  if (!post) return null;
  const crewName = (await store.name(match.crewId)) ?? "Your crew";
  return deliver(
    match.skipperId,
    post,
    confirmedPush(post, crewName),
    (to) => confirmedMessage(post, crewName, to, siteUrl),
    CONFIRMED_KINDS,
    deps,
  );
}
