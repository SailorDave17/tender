/**
 * `npm run vapid:keys` — print a fresh VAPID pair for a deployment (story #29 AC 7).
 *
 * A command rather than a line in the runbook saying `npx web-push generate-vapid-keys`, because
 * a command in a document is an instruction to reproduce a string exactly and every character is
 * a chance to fail (cairn: a-command-in-prose-is-not-a-capability). It also prints the two
 * environment names beside the two values, so nothing has to be matched up by hand — the public
 * one is `NEXT_PUBLIC_`, which means it reaches the browser, and the private one must not.
 *
 * The pair is generated locally and never sent anywhere: VAPID keys identify the server to a push
 * service, and nothing registers them in advance.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
A fresh VAPID pair. Put both in .env.local and in Vercel's environment
(Production and Preview), then redeploy — the public one is inlined into
the browser bundle at BUILD time, so a deployment built before it was set
will not have it.

Rotating these invalidates every existing push subscription: browsers hold
the public key inside the subscription they made. Every member would have
to press "Turn on notifications" again, and nothing tells them to. Generate
once, and only rotate if the private key has leaked.

  NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}
  VAPID_PRIVATE_KEY=${privateKey}
`);
