/**
 * The baseline security headers every response carries (#207; security-audit 2026-09-22, SA-6).
 * `next.config.ts` applies them to every path. Vercel already sends HSTS on its domains, so it is
 * not repeated here, and changing it is out of the story's scope.
 *
 * Each is defence in depth. None changes what a working page does; each contains a mistake made
 * later — injected markup, a page framed by another site, a file served under the wrong type.
 *
 * - `X-Content-Type-Options: nosniff`: a response is used only as the type it declares, so a file
 *   that is not a script is never run as one.
 * - `Referrer-Policy: strict-origin-when-cross-origin`: another origin is told this one's origin,
 *   never a path or a query string. It is also the browser's default, so stating it pins it rather
 *   than changing it.
 * - `Permissions-Policy`: switches off the powerful features the app never asks for. Every name is
 *   one Chrome recognises, because an unknown name is logged as a console ERROR ("Error with
 *   Permissions-Policy header: Unrecognized feature"), which Lighthouse's best-practices category
 *   counts. `identity-credentials-get` (FedCM) is deliberately absent: Google's sign-in button uses
 *   it on this origin (#173), and its default, `self` and delegable to Google's frame, is what that
 *   needs. Notifications and push are not policy-controlled features, so nothing here touches them.
 * - `Content-Security-Policy`: the narrow policy the story asks for, not a script policy.
 *   `frame-ancestors 'none'` lets no site frame any page, `object-src 'none'` allows no plugin
 *   content, and `base-uri 'none'` stops an injected `<base>` re-pointing every relative URL. There
 *   is no `script-src`, `connect-src`, `frame-src` or `worker-src`, so Google's script and frame,
 *   Supabase and the service worker are untouched; a nonce-based script policy is a separate story.
 *   There is no `form-action` either: it also governs the redirects that follow a form's post, and
 *   a blocked one shows no error page at all (cairn:
 *   csp-form-action-governs-the-redirects-after-a-form-post).
 *
 * `scripts/smoke-core.mjs` states the same values independently, and `test/security-headers.test.ts`
 * holds the two equal, so changing the policy is two deliberate edits.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "bluetooth=()",
      "browsing-topics=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "hid=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "serial=()",
      "usb=()",
    ].join(", "),
  },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'" },
];
