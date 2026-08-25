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
