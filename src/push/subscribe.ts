/**
 * A browser's `PushSubscription.toJSON()` into the row `0013` stores (story #29 AC 1).
 *
 * Pure and defensive, because the input is a JSON body a client posted: a Server Action receives
 * whatever the page sends, and the page sends whatever the browser produced. Everything the
 * database will refuse — a missing key, an endpoint that is not a URL — is refused here first
 * with a reason the profile page can explain, rather than reaching Postgres as a constraint
 * violation nobody can read.
 *
 * `person_id` is deliberately NOT a field here. It comes from the session on the server, never
 * from the request, and `0013`'s insert policy checks it against `auth.uid()` a second time — so
 * a crafted POST naming somebody else's id is refused by the database whatever this returns.
 */

export type SubscriptionInput = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
  expirationTime?: unknown;
};

export type ParsedSubscription =
  | { ok: true; endpoint: string; p256dh: string; auth: string }
  | { ok: false; reason: Refusal };

export type Refusal = "no-endpoint" | "bad-endpoint" | "no-keys";

/**
 * Endpoints are https URLs at the browser vendor's push service. http is refused: a push service
 * is never plaintext, and accepting one would store a row that can only ever fail to send.
 */
function isPushEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function parseSubscription(input: SubscriptionInput): ParsedSubscription {
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  if (!endpoint) return { ok: false, reason: "no-endpoint" };
  if (!isPushEndpoint(endpoint)) return { ok: false, reason: "bad-endpoint" };

  const p256dh = typeof input.keys?.p256dh === "string" ? input.keys.p256dh.trim() : "";
  const auth = typeof input.keys?.auth === "string" ? input.keys.auth.trim() : "";
  // Both or neither: a subscription missing either key cannot be encrypted to, so storing it
  // would queue a send that is guaranteed to fail and then look like a dead subscription.
  if (!p256dh || !auth) return { ok: false, reason: "no-keys" };

  return { ok: true, endpoint, p256dh, auth };
}

/** What the profile page says when a subscription is refused. */
export function explainSubscriptionRefusal(reason: string): string {
  switch (reason) {
    case "no-endpoint":
    case "bad-endpoint":
      return "That browser did not give us a usable push address. Notifications are not switched on.";
    case "no-keys":
      return "That browser did not give us the keys needed to send you a notification.";
    case "unsupported":
      return "This browser cannot do push notifications. On an iPhone, add Tender to your home screen first, then try again from there.";
    case "denied":
      return "Notifications are blocked for Tender in this browser's settings. Allow them there, then try again.";
    default:
      return "Notifications could not be switched on.";
  }
}
