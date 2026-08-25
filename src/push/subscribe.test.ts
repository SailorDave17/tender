import { describe, expect, it } from "vitest";
import { explainSubscriptionRefusal, parseSubscription } from "./subscribe";

/**
 * The parse between a browser and `0013` (story #29 AC 1). The input is a JSON body a client
 * posted, so every case here is one a crafted or broken request can actually produce.
 */

const good = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "BNc...", auth: "k3y" },
  expirationTime: null,
};

describe("parseSubscription", () => {
  it("takes a real subscription and keeps exactly the three columns 0013 stores", () => {
    expect(parseSubscription(good)).toEqual({
      ok: true,
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      p256dh: "BNc...",
      auth: "k3y",
    });
  });

  it("never returns a person_id, however hard the request tries", () => {
    // The ownership comes from the session on the server and is checked again by 0013's insert
    // policy. A request naming somebody else must not be able to smuggle it through the parse.
    const crafted = { ...good, person_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    expect(Object.keys(parseSubscription(crafted))).toEqual(["ok", "endpoint", "p256dh", "auth"]);
  });

  it("refuses a missing or blank endpoint", () => {
    expect(parseSubscription({ ...good, endpoint: undefined })).toEqual({ ok: false, reason: "no-endpoint" });
    expect(parseSubscription({ ...good, endpoint: "   " })).toEqual({ ok: false, reason: "no-endpoint" });
    expect(parseSubscription({ ...good, endpoint: 42 })).toEqual({ ok: false, reason: "no-endpoint" });
  });

  it("refuses an endpoint that is not an https URL", () => {
    // A push service is never plaintext. Storing one would queue a send guaranteed to fail and
    // then look, from the log, exactly like a dead subscription.
    expect(parseSubscription({ ...good, endpoint: "http://fcm.googleapis.com/x" })).toEqual({ ok: false, reason: "bad-endpoint" });
    expect(parseSubscription({ ...good, endpoint: "not a url" })).toEqual({ ok: false, reason: "bad-endpoint" });
    expect(parseSubscription({ ...good, endpoint: "javascript:alert(1)" })).toEqual({ ok: false, reason: "bad-endpoint" });
  });

  it("refuses a subscription missing either key — both or neither", () => {
    expect(parseSubscription({ ...good, keys: { auth: "k3y" } })).toEqual({ ok: false, reason: "no-keys" });
    expect(parseSubscription({ ...good, keys: { p256dh: "BNc..." } })).toEqual({ ok: false, reason: "no-keys" });
    expect(parseSubscription({ ...good, keys: null })).toEqual({ ok: false, reason: "no-keys" });
    expect(parseSubscription({ endpoint: good.endpoint })).toEqual({ ok: false, reason: "no-keys" });
  });

  it("trims, because a browser's JSON round trip is not always tidy", () => {
    const r = parseSubscription({ endpoint: ` ${good.endpoint} `, keys: { p256dh: " BNc... ", auth: " k3y " } });
    expect(r).toEqual({ ok: true, endpoint: good.endpoint, p256dh: "BNc...", auth: "k3y" });
  });
});

describe("explainSubscriptionRefusal", () => {
  it("tells an iPhone user the one thing that actually unblocks them", () => {
    // Apple offers push only to a home-screen web app. "Not supported" alone would send a crew
    // away believing their phone cannot do it, when it can once installed.
    expect(explainSubscriptionRefusal("unsupported")).toMatch(/home screen/i);
  });

  it("distinguishes a blocked permission from a broken browser", () => {
    expect(explainSubscriptionRefusal("denied")).toMatch(/blocked/i);
    expect(explainSubscriptionRefusal("denied")).not.toEqual(explainSubscriptionRefusal("unsupported"));
  });

  it("has a sentence for every reason parseSubscription can return, and a fallback", () => {
    for (const reason of ["no-endpoint", "bad-endpoint", "no-keys"]) {
      expect(explainSubscriptionRefusal(reason)).not.toBe("Notifications could not be switched on.");
    }
    expect(explainSubscriptionRefusal("something-new")).toBe("Notifications could not be switched on.");
  });
});
