/*
 * Tender's service worker (story #28).
 *
 * ONLINE ONLY: NO CACHED-BOARD PROMISE.
 *
 * This worker exists for one reason — an installed web app needs a registered service worker
 * before it can hold a push subscription at all, and web push from the home screen is ADR 007's
 * bet. It is not here to make Tender work offline, and it deliberately does not try.
 *
 * There is no listener for network requests in this file, and `test/service-worker.test.ts`
 * refuses to let one be added without that decision being reopened. The reason is a product
 * one rather than a technical one: the board's whole content is who still needs crew for
 * Sunday, and that answer changes the moment somebody answers a post. A cached board would
 * keep showing a need that has already been filled, so a crew would tap through, offer, and
 * find themselves second — which is worse than the honest failure of a page that will not load
 * because the phone has no signal. A dinghy park with no bars is exactly where this would
 * happen. If offline support is ever wanted it has to be designed around staleness (a visible
 * "as of" time, a refusal to answer from cache), and that is a story, not a listener.
 *
 * Everything here is therefore lifecycle only. `skipWaiting` and `clients.claim` are what make
 * the next version take over on the first load rather than the second — which matters for the
 * story after this one, since a worker that cannot be replaced cannot gain a push handler.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * Push (story #29).
 *
 * ALWAYS SHOW SOMETHING. A push that resolves without calling showNotification is a "silent
 * push", which no browser permits: Chrome posts its own "This site has been updated in the
 * background" notification instead, and Safari counts it against a budget and revokes the
 * subscription outright after a few. So every branch below ends in a notification, including the
 * ones where the payload is missing or unreadable — a vague notification is recoverable, a
 * revoked subscription is not, and the crew would have no idea it had happened.
 *
 * The payload is JSON built by src/push/payload.ts and is at most 4 KB (RFC 8291).
 */

const FALLBACK = { title: "Crew needed", body: "A skipper needs crew. Open Tender to see.", url: "/board" };

function readPayload(event) {
  if (!event.data) return FALLBACK;
  try {
    const parsed = event.data.json();
    if (!parsed || typeof parsed.title !== "string") return FALLBACK;
    return {
      title: parsed.title,
      body: typeof parsed.body === "string" ? parsed.body : FALLBACK.body,
      url: typeof parsed.url === "string" ? parsed.url : FALLBACK.url,
      tag: typeof parsed.tag === "string" ? parsed.tag : undefined,
    };
  } catch {
    return FALLBACK;
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // The mark, so the notification is recognisably Tender's on a crowded lock screen.
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.tag,
      // The URL travels in `data` rather than in the tag: the tag is a collapse key the browser
      // may overwrite, and losing the destination would leave a notification that opens nowhere.
      data: { url: payload.url },
    }),
  );
});

/*
 * A tap opens the post. If Tender is already open somewhere, that window is reused and moved —
 * opening a second one leaves a crew with two copies of the app and a back button that does not
 * go where they expect.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/board";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ("focus" in client) return client.navigate ? client.navigate(url).then((c) => c && c.focus()) : client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
