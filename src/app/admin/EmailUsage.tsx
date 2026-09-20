import { type EmailUsage as Usage, usageLevel, type UsageLevel } from "@/admin/email-usage";

/**
 * Resend's budget as /admin prints it (story #39, ADR 007's promised consequence). Split out of
 * the page so every reading — green, amber, red, and a read that failed — can be rendered in a
 * test with the figures handed in; the page itself is an async Server Component that reads the
 * session and the database.
 *
 * ## The colour is never the only signal
 *
 * Amber and red are a glance, not the message: each level also changes the sentence after the
 * figure, and `data-day-level` carries it for the tests. A counter whose whole warning is a
 * colour says nothing to a colour-blind admin and nothing at all when the mail client, the print
 * stylesheet or a screen reader drops the style — and this is the one number on the page whose
 * entire purpose is to be noticed before it is too late.
 *
 * ## A failed read is not a zero
 *
 * `loadEmailUsage` returns zeros with `error` set when the RPC fails, and this prints the failure
 * instead of the figures. "0 of 100 emails sent today" is the most reassuring thing this screen
 * can say, and it would be a lie told at exactly the moment the admin most needs the truth.
 *
 * ## What the note has to carry (AC 3)
 *
 * Three exclusions, because each one is a plausible reason for the number to look wrong: password
 * resets go through the same Resend account and are invisible here (they are sent by GoTrue, not
 * logged by this app); sends that the cap or a dedupe window skipped are logged but were never
 * attempts; and the day is UTC rather than the club's evening, so the count rolls over mid-morning
 * in Ohio.
 */
export function EmailUsage({ usage }: { usage: Usage }) {
  if (usage.error) {
    return (
      <p role="alert" data-usage-error>
        Could not read the email count: {usage.error}. The sending cap is unaffected — this is the
        screen, not the sender — but the day&rsquo;s budget is unknown until this reads again.
      </p>
    );
  }

  const dayLevel = usageLevel(usage.day, usage.dayCap);
  const monthLevel = usageLevel(usage.month, usage.monthCap);

  return (
    <>
      <p>
        <strong data-day-count={usage.day} data-day-level={dayLevel} style={colourOf(dayLevel)}>
          {usage.day} of {usage.dayCap}
        </strong>{" "}
        emails sent today{sentence(dayLevel)}
      </p>
      <p>
        <strong
          data-month-count={usage.month}
          data-month-level={monthLevel}
          style={colourOf(monthLevel)}
        >
          {usage.month} of {usage.monthCap.toLocaleString("en-US")}
        </strong>{" "}
        this month{sentence(monthLevel)}
      </p>
      <p data-usage-note style={{ fontSize: "0.875rem" }}>
        Counts notification emails Tender attempted, whether Resend accepted or refused them;
        it excludes password-reset mail (sent on the same Resend account, but not by this app),
        sends the cap or a repeat-window skipped, and anyone with no address on file — and the
        day runs 00:00–24:00 UTC, so it rolls over mid-morning here.
      </p>
    </>
  );
}

/**
 * The half of the warning that survives without CSS. Past red the wording is about consequence
 * rather than about the number: an admin who reads "sending will stop" does not have to know what
 * the cap is to know what to do.
 */
function sentence(level: UsageLevel): string {
  if (level === "red") return " — at the cap. Further notifications will be skipped, not queued.";
  if (level === "amber") return " — approaching the cap.";
  return ".";
}

function colourOf(level: UsageLevel): { color: string } | undefined {
  // #b26a00 rather than a named `orange`: amber on white needs the darker tone to clear 4.5:1.
  if (level === "red") return { color: "#b00020" };
  if (level === "amber") return { color: "#b26a00" };
  return undefined;
}
