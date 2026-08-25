import { rungOf, suggest, type Crew, type Post, type Rung } from "@/engine/ladder";
import type { Message, Transport } from "@/email/send";
import { ratingLabel } from "@/profile/profile";

/**
 * notifyRung(postId): propose the crew on the post's open rung and email each of them once
 * (story #23). The first half of ADR 007's bet — the notification is the product, the board is
 * the record.
 *
 * One call does four things, in order, all as the service role through the injected store:
 *
 *   1. Read the post and the crew available for its date, and run the engine. The open rung
 *      is max(stored, suggest()) — the stored rung never steps back up (0010's trigger
 *      refuses a decrease), and suggest() still widens on emptiness as it always has: a post
 *      with nobody on rung 1 opens at rung 2 the moment it is created.
 *   2. Persist the wider rung if the engine widened it.
 *   3. Write one suggestion row per available crew on or above the open rung, each at their
 *      own rung. The primary key makes this idempotent: a crew already suggested is left as
 *      they are, notified_at included.
 *   4. Email every suggestion not yet notified, and record each send in notification_log.
 *      Success sets notified_at; a transport failure is logged with its error and leaves
 *      notified_at NULL so the next call retries that person alone (AC 6). At or past the
 *      cap, the remaining sends are skipped and logged as rung_email_skipped_cap, again with
 *      notified_at NULL — tomorrow's first call sends them (AC 5). The cap counts rung_email
 *      rows — attempts, accepted or refused by the provider — and nothing else.
 *
 * Who calls it decides what "once" means. The call sites are the post-create action and the
 * availability-toggle action — a crew marking a day after a post opened is proposed and
 * emailed by the toggle (AC 3) — and nothing on a render path: a board read is a read.
 * `test/notify-call-sites.test.ts` holds the set of importers to those two files.
 *
 * Pure over its inputs: the store, the transport and `now` are injected, so the unit tests run
 * against an in-memory store with a fake transport and count recipients exactly.
 */

/** The 100/day Resend Free cap, less headroom for magic links. A recorded default, not a decision. */
export const EMAIL_DAY_CAP = 100;
export const EMAIL_HEADROOM = 5;
export const EMAIL_SKIP_AT = EMAIL_DAY_CAP - EMAIL_HEADROOM;

export const KIND_RUNG_EMAIL = "rung_email";
export const KIND_RUNG_EMAIL_SKIPPED_CAP = "rung_email_skipped_cap";
/** A suggestion with no contact row to send to — logged, never retried by this call, not an attempt for the cap. */
export const KIND_RUNG_EMAIL_NO_ADDRESS = "rung_email_no_address";

export type RungPost = {
  id: string;
  raceDateId: string;
  boatClass: string;
  boatName: string;
  minimum: 1 | 2 | 3 | 4;
  /** The race date's start, ISO. */
  startsAt: string;
  /** The race date's title, for the subject line. */
  dateTitle: string;
  currentRung: Rung;
  closedAt: string | null;
};

export type Pending = {
  personId: string;
  rung: Rung;
  /** NULL when the person has no contact row — logged as an error, never sent. */
  email: string | null;
};

export type LogEntry = {
  kind: string;
  channel: "email";
  personId: string;
  toEmail: string | null;
  postId: string;
  providerId: string | null;
  error: string | null;
};

export interface RungStore {
  post(postId: string): Promise<RungPost | null>;
  /** Every rated person available for the date, as the engine sees them. */
  pool(raceDateId: string): Promise<Crew[]>;
  /** Only ever called with a rung above the stored one. */
  raiseRung(postId: string, rung: Rung): Promise<void>;
  /** Insert, ignoring pairs already present. */
  addSuggestions(rows: { postId: string; personId: string; rung: Rung }[]): Promise<void>;
  /** Suggestions on the post with notified_at NULL, with each person's email. */
  pending(postId: string): Promise<Pending[]>;
  /** Email sends attempted so far in the day `now` falls in. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: LogEntry): Promise<void>;
  markNotified(postId: string, personId: string, at: Date): Promise<void>;
}

export type NotifyResult = {
  /** The rung the post is open to after this call. */
  rung: Rung;
  suggested: number;
  sent: number;
  skippedCap: number;
  failed: number;
};

export type NotifyDeps = {
  store: RungStore;
  transport: Transport;
  now: Date;
  /** The site's origin, for the link in the email — `https://tender.madcowsailing.com`. */
  siteUrl: string;
};

/**
 * The half of the store dispatch needs — the queue, the cap, the log and the mark. Split out
 * with `dispatchPending()` below so the ladder tick (#25) can send without a second copy of the
 * cap, the retry rule or the no-address case: the tick owns which posts widened, this owns what
 * a send means. `RungStore` still satisfies it, so notifyRung()'s own callers are unchanged.
 */
export type DispatchStore = Pick<RungStore, "pending" | "emailsSentToday" | "log" | "markNotified">;

export type DispatchDeps = {
  store: DispatchStore;
  transport: Transport;
  now: Date;
  /** The site's origin, for the link in the email — `https://tender.madcowsailing.com`. */
  siteUrl: string;
};

export type DispatchResult = { sent: number; skippedCap: number; failed: number };

/**
 * The day the cap counts within: UTC. Resend's documentation states the daily limit without a
 * zone; UTC is the recorded default, and the club's evening is mid-day UTC the next morning
 * either way — what matters is that the count and the provider agree on roughly one day.
 */
export function emailDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The open rung of a post: the stored rung, or wider if the engine widened it now. */
export function openRung(stored: Rung, computed: Rung): Rung {
  return stored > computed ? stored : computed;
}

/** What a crew reads. Exported so the copy is tested, not so anything else sends it. */
export function rungMessage(post: RungPost, to: string, siteUrl: string): Message {
  const when = new Date(post.startsAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  // From RATINGS rather than a map of its own: this line carried a hard-coded three-level copy
  // of the scale, which 0011's fourth level would have rendered as "undefined" in a real email
  // with nothing failing (story #69). The same lowercasing idiom is on /boats and /post/[id].
  const minimum = ratingLabel(post.minimum).toLowerCase();
  return {
    to,
    subject: `Crew needed: ${post.boatName} (${post.boatClass}), ${when}`,
    text: [
      `A skipper needs crew on ${post.boatName} (${post.boatClass}) for ${post.dateTitle}, ${when}.`,
      `Minimum competence: ${minimum}. You marked that day as available, so you are on the list.`,
      ``,
      `If you can, say so here: ${siteUrl}/post/${post.id}`,
      ``,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

/**
 * Step 4 alone: email everyone on the post with `notified_at` still NULL, under the day's cap.
 *
 * Every rule about SENDING lives here and nowhere else — the cap and its headroom, the
 * attempt-counts-whether-or-not-the-provider-accepts rule, the log line per outcome, and which
 * failures leave `notified_at` NULL so the next call retries that person alone. notifyRung()
 * calls it after running the ladder; the tick route calls it after runTick() has widened a post,
 * which is what "dispatch is reused from the email story, not rebuilt" means (#25).
 *
 * It sends to whoever is pending, not to whoever the caller thinks is new. That is what makes
 * "run the tick again a minute later and nothing is emailed" true for a second, independent
 * reason: the first pass set `notified_at`.
 */
export async function dispatchPending(post: RungPost, deps: DispatchDeps): Promise<DispatchResult> {
  const { store, transport, now, siteUrl } = deps;
  const pending = await store.pending(post.id);
  let sentToday = await store.emailsSentToday(now);
  const result: DispatchResult = { sent: 0, skippedCap: 0, failed: 0 };
  for (const p of pending) {
    if (p.email === null) {
      result.failed += 1;
      await store.log({ kind: KIND_RUNG_EMAIL_NO_ADDRESS, channel: "email", personId: p.personId, toEmail: null, postId: post.id, providerId: null, error: "no contact email" });
      continue;
    }
    if (sentToday >= EMAIL_SKIP_AT) {
      result.skippedCap += 1;
      await store.log({ kind: KIND_RUNG_EMAIL_SKIPPED_CAP, channel: "email", personId: p.personId, toEmail: p.email, postId: post.id, providerId: null, error: null });
      continue;
    }
    sentToday += 1; // counted whether or not the provider accepts it: an attempt is what the cap is about
    try {
      const { id } = await transport.send(rungMessage(post, p.email, siteUrl));
      await store.log({ kind: KIND_RUNG_EMAIL, channel: "email", personId: p.personId, toEmail: p.email, postId: post.id, providerId: id, error: null });
      await store.markNotified(post.id, p.personId, now);
      result.sent += 1;
    } catch (e) {
      result.failed += 1;
      const error = e instanceof Error ? e.message : String(e);
      await store.log({ kind: KIND_RUNG_EMAIL, channel: "email", personId: p.personId, toEmail: p.email, postId: post.id, providerId: null, error });
    }
  }
  return result;
}

export async function notifyRung(postId: string, deps: NotifyDeps): Promise<NotifyResult | null> {
  const { store, transport, now, siteUrl } = deps;
  const post = await store.post(postId);
  if (!post || post.closedAt !== null) return null;

  // 1. The engine, over today's pool, against the stored rung.
  const pool = await store.pool(post.raceDateId);
  const enginePost: Post = { raceAt: new Date(post.startsAt), boatClass: post.boatClass, minimum: post.minimum };
  const computed = suggest(enginePost, pool, now).rung;
  const rung = openRung(post.currentRung, computed);

  // 2. Persist a widening only; a decrease is never asked for, and 0010 would refuse it.
  if (rung > post.currentRung) await store.raiseRung(post.id, rung);

  // 3. Everyone available on or above the open rung, at their own rung.
  const candidates = pool
    .filter((crew) => crew.available)
    .map((crew) => ({ postId: post.id, personId: crew.id, rung: rungOf(enginePost, crew) }))
    .filter((c) => c.rung <= rung);
  if (candidates.length > 0) await store.addSuggestions(candidates);

  // 4. Send to whoever has not been told, under the cap — dispatchPending() above, which the
  // ladder tick calls with the same post and the same rules.
  const dispatched = await dispatchPending(post, { store, transport, now, siteUrl });
  return { rung, suggested: candidates.length, ...dispatched };
}
