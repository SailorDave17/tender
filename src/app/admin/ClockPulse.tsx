import { lastTickLabel } from "@/engine/tick";

/**
 * The ladder's two clocks as /admin prints them: the quarter-hour tick (#25 AC 5) and, since #145,
 * Vercel's daily sweep beside it. Split out of the page so both readings, and "never", can be
 * rendered in a test with the timestamps handed in. The page itself is an async Server Component
 * that reads the session and the database.
 *
 * The sweep also prints its time in UTC, not only "N min ago". Its schedule is an HOUR, not a
 * minute (Hobby fires `0 12 * * *` anywhere in 12:00–13:00 UTC), and #145's last criterion is
 * exactly the question "did the stamp land inside that window", which a relative age answers
 * only after arithmetic.
 */
export function ClockPulse({ lastAt, sweepAt, now }: { lastAt: Date | null; sweepAt: Date | null; now: Date }) {
  return (
    <>
      <p>
        Last tick <strong data-last-tick>{lastTickLabel(lastAt, now)}</strong>. The clock widens an
        untaken post to amber 48 h before the race and to red at 24 h, and emails the crew it
        reaches. It should run every 15 minutes; a number climbing past that means it has stopped.
      </p>
      <p>
        Last daily sweep <strong data-last-sweep>{lastTickLabel(sweepAt, now)}</strong>
        {sweepAt && (
          <>
            {" "}
            (<time dateTime={sweepAt.toISOString()}>{utcMinute(sweepAt)}</time>)
          </>
        )}
        . Vercel calls the same clock once a day, some time between 12:00 and 13:00 UTC, so it still
        runs if the 15-minute clock stops. It should stay under about 1500 min; past that, the daily
        sweep has stopped too.
      </p>
    </>
  );
}

/** `2026-09-14 12:37 UTC` — to the minute, because the window being checked is an hour wide. */
function utcMinute(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
