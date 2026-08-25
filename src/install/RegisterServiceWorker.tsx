"use client";

import { useEffect } from "react";

/**
 * Registers `/sw.js` (story #28 AC 4). Renders nothing.
 *
 * The registration is what AC 4 measures — `navigator.serviceWorker.ready` resolving with scope
 * `/` — and it is the reason the whole story exists: a push subscription is reached only through
 * a `ServiceWorkerRegistration`, so without this line story #29 has nothing to subscribe to.
 *
 * Scope `/` rather than the default. The default scope is the directory the worker is served
 * from, which for `/sw.js` is already `/` — stating it means a later move of the file (to
 * `/static/sw.js`, say) fails loudly at registration instead of quietly narrowing which pages
 * the worker controls. `updateViaCache: "none"` stops the browser serving the worker itself from
 * its HTTP cache, which is what otherwise leaves a phone running last week's worker for a day.
 *
 * Mounted on /board only, deliberately. Registering from the root layout would install a worker
 * for signed-out visitors on `/` and `/join`, who have nothing to be pushed about. When #29 adds
 * the subscribe control to /profile it will want this there too — the registration is per-origin
 * and persists, so a crew who has ever loaded the board is already covered, but a crew who lands
 * straight on /profile is not, and that is #29's to fix rather than something to pre-empt here.
 *
 * Failure is swallowed to a console warning on purpose. There is no service worker at all in
 * Firefox private windows or in an iOS in-app browser, and the board must not break for someone
 * reading it inside a link they tapped in Messages; what they lose is push, which they could not
 * have had anyway.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error) => {
      console.warn("service worker registration failed", error);
    });
  }, []);

  return null;
}
