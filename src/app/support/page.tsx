import type { Metadata } from "next";
import { loadSupportAddress } from "@/support/contact";

export const metadata: Metadata = { title: "Support · Tender" };

/**
 * /support — who to write to, how soon to expect an answer, and what is already known to be
 * wrong (story #147 AC 1). Open to anyone: it is not under `PROTECTED_PREFIXES`
 * (`src/auth/gate.ts`), because the person who needs it most is the one who cannot sign in, and
 * because madcowsailing.com's product page links here for people who have never had an account.
 *
 * The address is the club row's `admin_email`, read per request (`src/support/contact.ts` says
 * why it is not a literal). A read the platform refuses renders the page anyway, with a sentence
 * of its own rather than the no-address one, which would be untrue (#204, `./contact-read.ts`).
 * The response time is the owner's promise, chosen at pickup
 * (2026-09-21). The known issues are the two standing limitations a member runs into that are
 * already recorded elsewhere, and each names its source here so the list can be re-checked
 * rather than trusted:
 *
 *   - iPhone push needs a Home Screen install: ADR 007 (measured, iOS 16.4+) and the charter's
 *     Integrations row, "iOS requires Home Screen install". The wording is the install banner's
 *     (`src/install/InstallBanner.tsx`), so a member reads the same steps in both places.
 *   - The daily email cap: the charter's Resend row (100/day) and `EMAIL_SKIP_AT` in
 *     `src/notify/rung.ts` — notifications stop five short of the cap so a password reset can
 *     still be sent, and a skipped send is skipped, never queued.
 *
 * When either stops being true, this list is wrong until someone edits it. That is the cost of
 * a hand-written list, accepted at pickup over leaving it empty and hiding both.
 */
export default async function SupportPage() {
  const contact = await loadSupportAddress();
  return (
    <main data-page="support">
      <h1>Support</h1>
      {contact.kind === "address" ? (
        <>
          <p data-contact>
            Stuck, or something looks wrong? Email <a href={`mailto:${contact.address}`}>{contact.address}</a>.
          </p>
          <p data-response-time>You should hear back within two days.</p>
        </>
      ) : contact.kind === "unreadable" ? (
        <p data-contact="unreadable">
          The club&apos;s contact address could not be loaded just now. Reload this page in a moment,
          or ask whoever gave you the club&apos;s invite code.
        </p>
      ) : (
        <p data-contact="none">
          The club has not given Tender a contact address yet. Ask whoever gave you the club&apos;s
          invite code.
        </p>
      )}
      <p>
        It helps to say which page you were on and what you tapped, and to copy the small line at
        the very bottom of the page: it says which version of Tender you are using.
      </p>

      <h2>Known issues</h2>
      <ul data-known-issues>
        <li>
          <strong>On an iPhone, notifications need Tender on your home screen.</strong> Apple only
          lets an installed web app send notifications, so tap <strong>Share</strong> at the bottom
          of Safari, then <strong>Add to Home Screen</strong>, before turning them on from your
          profile. You still get the emails in the meantime.
        </li>
        <li>
          <strong>Email has a daily limit.</strong> Tender can send about 100 emails a day. On a
          very busy day, notification emails past that point are skipped rather than sent late, so
          check the board before a race: it always shows every crew need.
        </li>
      </ul>

      <h2>Your data</h2>
      <p>
        <a href="/privacy">What Tender keeps about you, and who can see it</a>.
      </p>
    </main>
  );
}
