import webpush from "web-push";
import { encodePush, type PushPayload } from "./payload";

/**
 * Outbound web push, behind an injectable transport — the same shape as `src/email/send.ts`, so
 * `dispatchPending()` treats the two channels alike and the tests hand in a fake.
 *
 * WHY A DEPENDENCY HERE WHEN EMAIL DELIBERATELY HAS NONE. `src/email/send.ts` says the `resend`
 * SDK wraps one POST and is therefore not worth a dependency. Web push is not that: RFC 8291
 * requires the payload be encrypted to the subscription's own keys (ECDH on P-256, HKDF, then
 * AES-128-GCM with a per-message salt) and RFC 8292 requires a signed VAPID JWT in the
 * Authorization header. That is real cryptography with real ways to be subtly wrong, and
 * `.env.example` has named `npx web-push generate-vapid-keys` since #28 — so the library was
 * already the intended tool rather than a choice made here.
 *
 * A SUBSCRIPTION THAT IS GONE IS NOT AN ERROR TO RETRY. A push service answers 404 or 410 when
 * the browser has discarded the subscription — the app was uninstalled, the user cleared site
 * data, the endpoint expired. That is permanent, and the row must be deleted rather than tried
 * again tomorrow (AC 3). `gone` is what tells the caller which of the two happened; every other
 * status is an ordinary failure that leaves the row alone.
 */

export type PushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushOutcome =
  | { ok: true }
  /** The subscription is permanently dead: delete the row. */
  | { ok: false; gone: true; error: string }
  /** Something else went wrong; the row stands and the next run may try again. */
  | { ok: false; gone: false; error: string };

export interface PushTransport {
  /**
   * TOTAL: answers an outcome and never throws, including on a payload it refuses to encode.
   *
   * `dispatchPending` calls this without a try, and deliberately — a throw there would abort the
   * whole post's dispatch, taking the EMAIL down with it for every other crew on the rung, over
   * one device. So everything that can go wrong comes back as `{ ok: false }` and the loop
   * carries on to the next person.
   */
  send(target: PushTarget, payload: PushPayload): Promise<PushOutcome>;
}

/** The `mailto:` VAPID subject. RFC 8292 wants a contact for whoever operates the pusher. */
export const VAPID_SUBJECT = "mailto:tender@tender.madcowsailing.com";

/**
 * Statuses that mean *this subscription will never work again*. 404 is the endpoint not existing;
 * 410 Gone is the push service's documented way of retiring one.
 */
export function isGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

/**
 * How long a push service holds an undelivered notification for a phone that is off.
 *
 * Six hours, and the number is a product decision rather than a default: a crew need for
 * Sunday's race is worth delivering to a phone that comes back on this evening, and worthless
 * delivered on Monday. A crew whose phone was off longer than that reads the board.
 */
export const PUSH_TTL_SECONDS = 6 * 60 * 60;

/**
 * The real transport. Keys are read here and nowhere else in `src/`; the private one is never
 * exported and never reaches a bundle — `test/push-key-scope.test.ts` holds that by grep (AC 7).
 */
export function webPushTransport(
  publicKey: string | undefined = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  privateKey: string | undefined = process.env.VAPID_PRIVATE_KEY,
  send: typeof webpush.sendNotification = webpush.sendNotification,
): PushTransport {
  if (!publicKey) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY is not set");
  if (!privateKey) throw new Error("VAPID_PRIVATE_KEY is not set");
  return {
    async send(target, payload) {
      try {
        await send(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          encodePush(payload),
          { vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey }, TTL: PUSH_TTL_SECONDS },
        );
        return { ok: true };
      } catch (e) {
        const status = e instanceof webpush.WebPushError ? e.statusCode : undefined;
        const error = e instanceof Error ? e.message : String(e);
        return { ok: false, gone: isGone(status), error: error.slice(0, 200) };
      }
    },
  };
}
