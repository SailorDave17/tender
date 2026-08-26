"use client";

import { useState } from "react";
import { deletePushSubscription, savePushSubscription } from "@/app/profile/push-actions";
import { explainSubscriptionRefusal } from "./subscribe";

/**
 * "Turn on notifications" on /profile (story #29 AC 1).
 *
 * A client component because every step of it is a browser capability: the permission prompt,
 * the service worker registration and `pushManager.subscribe()` have no server equivalent. The
 * only thing that reaches the server is the resulting subscription, through a Server Action.
 *
 * THE ORDER MATTERS. Permission is requested BEFORE subscribing, because `subscribe()` on a
 * denied origin rejects with a `NotAllowedError` that reads like a bug rather than a choice the
 * person made. And the row is saved AFTER the browser subscription exists, so a stored row
 * always corresponds to a real device — if the save then fails, the browser half is undone
 * rather than left as a subscription the server does not know about, which would be a device
 * that can never be pushed and never be cleaned up.
 *
 * `applicationServerKey` must be a Uint8Array, not the base64url string, in every browser — the
 * conversion is below rather than pulled in, because it is eight lines and a dependency here
 * would ship to the phone.
 */

/**
 * The return type is `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, and the buffer is
 * allocated explicitly to get it. Since TypeScript 5.7 `Uint8Array` is generic over its backing
 * store and defaults to `ArrayBufferLike`, which `BufferSource` — what `applicationServerKey`
 * takes — does not accept. `Uint8Array.from(...)` produces the wide form, so the tidier spelling
 * does not compile. A cast would have silenced it and said nothing about why.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function PushToggle({ vapidPublicKey, subscribed }: { vapidPublicKey: string; subscribed: boolean }) {
  const [on, setOn] = useState(subscribed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setError(explainSubscriptionRefusal("unsupported"));
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") {
        setError(explainSubscriptionRefusal("denied"));
        return;
      }
      // The board registers the worker, but a crew who lands straight here has never loaded it —
      // #28's own note said this story would need that, so register before waiting on ready.
      await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const result = await savePushSubscription(JSON.parse(JSON.stringify(subscription)));
      if (!result.ok) {
        // Undo the browser half so a subscription the server never stored cannot linger.
        await subscription.unsubscribe().catch(() => {});
        setError(explainSubscriptionRefusal(result.reason));
        return;
      }
      setOn(true);
    } catch {
      setError(explainSubscriptionRefusal("unknown"));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Tell the server first: a row with no browser subscription behind it is a push that
        // fails forever, where a browser subscription the server forgot is simply inert.
        await deletePushSubscription(subscription.endpoint);
        await subscription.unsubscribe().catch(() => {});
      }
      setOn(false);
    } catch {
      setError(explainSubscriptionRefusal("unknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      {on ? (
        <p data-push-on>
          Notifications are on for this device.{" "}
          <button type="button" onClick={turnOff} disabled={busy} data-push-off-button>
            Turn them off
          </button>
        </p>
      ) : (
        <p>
          <button type="button" onClick={turnOn} disabled={busy} data-push-on-button>
            Turn on notifications
          </button>{" "}
          — the fastest way to hear that a skipper needs you.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
