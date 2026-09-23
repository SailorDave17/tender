import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy · Tender" };

/**
 * /privacy — what Tender keeps about a member, who can see each part of it, and how to have it
 * deleted, in a member's words (story #147 AC 2). Open to anyone, like /support: it is not under
 * `PROTECTED_PREFIXES`, and madcowsailing.com's product page links here.
 *
 * EVERY SENTENCE HERE IS A CLAIM ABOUT THE SCHEMA, and the schema is what it was checked
 * against: `docs/charter.md` §Data for what is held and what deletion does, and the migrations'
 * grants and policies for who can read it. The PR for #147 lists each claim beside its source.
 * The hazard is the one race-timer's published policy hit (cairn:
 * `a-cross-check-pins-the-axis-it-compares`): a page that is right about most things and states
 * the wrong side of one. So where the migrations say more than the charter, this page says what
 * the migrations do — the charter says contact details go "only to the two people in a match",
 * and 0023 also lets the club admin read every thread; both are here.
 *
 * WHEN A MIGRATION CHANGES WHO CAN READ SOMETHING, THIS PAGE IS WRONG UNTIL IT IS EDITED. Nothing
 * mechanical holds the two together: a claim is not comparable the way a count is. The sections
 * carry `data-section` hooks so a test can find them, and that test pins the sentences most
 * likely to be quietly falsified — contact details, the admin's reading of threads, what
 * deletion keeps.
 */
export default function PrivacyPage() {
  return (
    <main data-page="privacy">
      <h1>Privacy</h1>
      <p>
        Tender is the club&apos;s crew board. This page says what it keeps about you, who can see
        it, and how to have it deleted. Questions go to the address on the{" "}
        <a href="/support">Support</a> page.
      </p>

      <section data-section="holds">
        <h2>What Tender keeps about you</h2>
        <ul>
          <li>Your name, and your email address, which is how you sign in.</li>
          <li>
            Your password, if you set one. It is held by Tender&apos;s sign-in service in a form
            nobody can read back.
          </li>
          <li>
            If you sign in with Google: the email address, name and profile picture link Google
            sends, kept with your sign-in. The name on the board is the one you typed.
          </li>
          <li>Your phone number, only if you add one.</li>
          <li>The skills you tick and the hulls you will sail.</li>
          <li>
            That you confirmed you are 18 or over, and when. Tender does not store your date of
            birth or your age.
          </li>
          <li>The race days you say you can sail.</li>
          <li>
            Boats you add, crew needs you post and their notes, your &ldquo;I can&rdquo; answers,
            your matches, and whether each one sailed.
          </li>
          <li>Messages in your match threads.</li>
          <li>
            If you turn on notifications, an address for your device that your browser&apos;s push
            service gives Tender.
          </li>
          <li>A record of each email and notification Tender sends you: what kind, to which address, and when.</li>
          <li>If the club admin suspends you or removes one of your messages: that it happened, and when.</li>
          <li data-claim="attempts">
            When someone gets an invite code or a password wrong, or asks for a reset link: a
            scrambled form of the internet address it came from and of the email address it named,
            which cannot be turned back into either, and when. Tender uses it only to stop anyone
            guessing, and deletes it after 15 minutes.
          </li>
          <li>
            Cookies that keep you signed in, and one that remembers for a year that this device has
            signed in before, so the sign-in page opens on the right tab.
          </li>
        </ul>
        <p>
          Tender runs no analytics and shows no advertising. The sign-in page loads Google&apos;s
          sign-in button from Google.
        </p>
      </section>

      <section data-section="who-sees">
        <h2>Who can see it</h2>
        <ul>
          <li data-claim="members">
            <strong>Every signed-in member</strong> can see your name, when you joined and when you
            finished your profile, your skills
            and hulls, the race days you are available, your boats, the crew needs you post, and
            who is matched with whom.
          </li>
          <li data-claim="contact">
            <strong>Your email address and phone number</strong> are seen by you and by anyone you
            are matched with: once a skipper accepts your &ldquo;I can&rdquo;, the two of you can
            see each other&apos;s, and still can after the race. No other Tender screen shows
            them, the club admin&apos;s included.
          </li>
          <li data-claim="answers">
            <strong>Your &ldquo;I can&rdquo; answers</strong> are seen by you and by the skipper
            whose post you answered.
          </li>
          <li data-claim="messages">
            <strong>Messages in a match thread</strong> are seen by the two of you, and by the club
            admin, who can read any thread in order to moderate it. If the admin removes a message,
            its original text is kept where only the admin can read it.
          </li>
          <li data-claim="self">
            <strong>Your device&apos;s notification address</strong> is seen by you alone, and a
            suspension by you and the club admin.
          </li>
          <li data-claim="email-record">
            <strong>The record of emails sent</strong> is not shown to any member. The admin&apos;s
            screen shows only how many went out.
          </li>
          <li data-claim="signed-out">
            <strong>Anyone not signed in</strong> sees none of it. The one exception is the club
            admin&apos;s contact address, which the Support page shows so that anyone can reach
            them.
          </li>
        </ul>
        <p>
          The person who runs Tender for the club can reach the database behind it, as whoever runs
          any website can.
        </p>
      </section>

      <section data-section="services">
        <h2>Who else handles it</h2>
        <ul>
          <li>
            <strong>Supabase</strong> stores the database and runs sign-in.
          </li>
          <li>
            <strong>Vercel</strong> hosts the site.
          </li>
          <li>
            <strong>Resend</strong> sends Tender&apos;s emails, so it sees your email address and
            what Tender is telling you.
          </li>
          <li>
            <strong>Google</strong>, if you sign in with Google.
          </li>
          <li>
            <strong>Apple, Google or Mozilla</strong>, whichever makes your browser, delivers
            notifications if you turn them on.
          </li>
        </ul>
      </section>

      <section data-section="delete">
        <h2>Deleting your account</h2>
        <p>
          You can delete your account yourself from your profile: <strong>Delete my account</strong>.
          That removes your profile, your email address and phone, your availability, your answers,
          the messages you wrote, your notification devices, and your sign-in.
        </p>
        <p>Some things stay, with your name taken off, so the club&apos;s record of each race day still adds up:</p>
        <ul data-kept>
          <li>a race you were matched for stays as a match with your side blank;</li>
          <li>boats you added stay, with no owner, so past races still show the boat;</li>
          <li>crew needs you posted stay, notes included;</li>
          <li>
            the record of emails and notifications sent to you stays, without your name, your email
            address or your device&apos;s notification address.
          </li>
        </ul>
        <p>You can also ask for your account to be deleted, using the address on the Support page.</p>
      </section>

      <section data-section="copy">
        <h2>A copy of your data</h2>
        <p>Ask, using the address on the Support page, and you will be sent a copy of what Tender keeps about you.</p>
      </section>

      <section data-section="adults">
        <h2>Adults only</h2>
        <p>
          Tender is for adults. Everyone confirms they are 18 or over when they sign up, and Tender
          has no accounts for anyone younger.
        </p>
      </section>

      <p data-updated>
        Last updated <time dateTime="2026-09-21">21 September 2026</time>.
      </p>
    </main>
  );
}
