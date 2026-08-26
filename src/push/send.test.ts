import { describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { PUSH_TTL_SECONDS, VAPID_SUBJECT, isGone, webPushTransport } from "./send";
import { rungPush } from "./payload";
import type { RungPost } from "@/notify/rung";

/**
 * The real transport's decisions (story #29 AC 3).
 *
 * This file exists because `push-dispatch.test.ts` INJECTS the outcome — its fake answers
 * `{ ok: false, gone: true }` because the test says so, which proves what dispatch does with that
 * answer and nothing about whether the real transport ever produces it. The classification is the
 * claim AC 3 actually rests on, and a fake written by the same hand cannot disagree with me about
 * it (cairn: a-fake-cannot-disagree-with-its-author-2026-08-24).
 *
 * `web-push` itself is not exercised — its cryptography is the library's business. What is
 * exercised is everything around it: which statuses are permanent, what is passed in, and that a
 * missing key is refused rather than sent without one.
 */

const post: RungPost = {
  id: "11111111-1111-4111-8111-111111111111",
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: null,
};
const target = { endpoint: "https://push.example/ana/1", p256dh: "BNc...", auth: "k3y" };
// Deliberately NOT a real pair. `sendNotification` is stubbed in every case here and nothing
// validates the key shape, so a real-looking base64url private key would be a live-shaped secret
// committed to a public repo for no benefit — and the first thing a secret scanner flags.
const PUBLIC = "test-public-key-not-a-real-vapid-key";
const PRIVATE = "test-private-key-not-a-real-vapid-key";

describe("isGone — which failures are permanent", () => {
  it("404 and 410 mean the subscription will never work again", () => {
    expect(isGone(404)).toBe(true);
    expect(isGone(410)).toBe(true);
  });

  it("everything else is transient, and must NOT delete the row", () => {
    // Deleting on a 500 or a rate limit would silently unsubscribe a crew who did nothing wrong,
    // and nothing would tell them their notifications had stopped.
    for (const status of [400, 401, 403, 408, 413, 429, 500, 502, 503, undefined]) {
      expect(isGone(status), `status ${status} must not be treated as gone`).toBe(false);
    }
  });
});

describe("webPushTransport", () => {
  it("refuses to exist without keys, rather than sending unsigned", () => {
    expect(() => webPushTransport(undefined, PRIVATE)).toThrow(/NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
    expect(() => webPushTransport(PUBLIC, undefined)).toThrow(/VAPID_PRIVATE_KEY/);
    expect(() => webPushTransport("", PRIVATE)).toThrow(/NEXT_PUBLIC_VAPID_PUBLIC_KEY/);
  });

  it("passes the subscription, the encoded payload and the VAPID details to the library", async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 201 });
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    const payload = rungPush(post, 2);

    expect(await transport.send(target, payload)).toEqual({ ok: true });

    expect(send).toHaveBeenCalledTimes(1);
    const [subscription, body, options] = send.mock.calls[0];
    expect(subscription).toEqual({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } });
    expect(JSON.parse(body as string)).toEqual(payload); // encoded, and therefore size-checked
    expect(options).toEqual({ vapidDetails: { subject: VAPID_SUBJECT, publicKey: PUBLIC, privateKey: PRIVATE }, TTL: PUSH_TTL_SECONDS });
  });

  it("maps a WebPushError's 410 to gone, so dispatch deletes the row", async () => {
    const send = vi.fn().mockRejectedValue(new webpush.WebPushError("gone", 410, {}, "", target.endpoint));
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    const outcome = await transport.send(target, rungPush(post, 1));
    expect(outcome).toEqual({ ok: false, gone: true, error: expect.stringContaining("gone") });
  });

  it("maps a WebPushError's 500 to a keep-the-row failure", async () => {
    const send = vi.fn().mockRejectedValue(new webpush.WebPushError("boom", 500, {}, "", target.endpoint));
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    expect(await transport.send(target, rungPush(post, 1))).toMatchObject({ ok: false, gone: false });
  });

  it("a plain Error — a socket hang-up, say — is a failure and never `gone`", async () => {
    // It carries no statusCode at all. Treating an unknown throw as permanent would delete
    // subscriptions on a network blip.
    const send = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    expect(await transport.send(target, rungPush(post, 1))).toEqual({ ok: false, gone: false, error: "socket hang up" });
  });

  it("truncates the error, because it lands in a notification_log column a person may read", async () => {
    const send = vi.fn().mockRejectedValue(new Error("x".repeat(500)));
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    const outcome = await transport.send(target, rungPush(post, 1));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.length).toBe(200);
  });

  it("a payload over the protocol limit is never sent, and is reported rather than thrown", async () => {
    // The transport's contract is TOTAL: it answers an outcome and never throws, because the
    // dispatch loop calls it without a try and a throw there would abort the EMAIL for everyone
    // else on the post. So an oversized payload is a non-gone failure — the subscription is fine,
    // the payload is not — and the row is kept.
    const send = vi.fn();
    const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
    const huge = { ...rungPush(post, 1), body: "x".repeat(5000) };

    const outcome = await transport.send(target, huge);
    expect(outcome).toEqual({ ok: false, gone: false, error: expect.stringContaining("RFC 8291") });
    expect(send).not.toHaveBeenCalled(); // it never reached the network
  });

  it("never throws, whatever the library does — the dispatch loop depends on it", async () => {
    // The positive control on the claim above. A transport that threw on some path would take
    // the whole post's dispatch down with it, email included.
    for (const thrown of [new Error("boom"), "a bare string", null, undefined]) {
      const send = vi.fn().mockRejectedValue(thrown);
      const transport = webPushTransport(PUBLIC, PRIVATE, send as unknown as typeof webpush.sendNotification);
      await expect(transport.send(target, rungPush(post, 1))).resolves.toMatchObject({ ok: false });
    }
  });
});
