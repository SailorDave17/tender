import { EMAIL_ATTEMPT_KINDS } from "@/notify/kinds";
import { EMAIL_DAY_CAP, EMAIL_MONTH_CAP, emailDayStart, emailMonthStart } from "@/notify/rung";
import type { supabaseServer } from "@/lib/supabase/server";

/**
 * What /admin reads of the email log, and how it colours it (story #39, ADR 007's promised
 * consequence: "the admin view shows the day's send count against 100").
 *
 * ## The count is ATTEMPTS, not every email-channel row
 *
 * Story #39's AC 1 says "channel = email rows", and that is not what this counts — owner decision
 * at pickup, 2026-09-20. `notification_log` logs a `channel: "email"` row for things that never
 * reached the provider: `*_skipped_cap` when the cap already bit, `*_no_address` when there was
 * nobody to send to, `*_suppressed` when a dedupe window swallowed it. Counting those would make
 * this screen read HIGHER than the cap the senders actually enforce, and it would do so precisely
 * on the day the cap starts biting — a skipped recipient logs a row each — so the screen would go
 * red while `notifyRung()` and its four siblings were still sending happily. The number here is
 * the one they enforce: `EMAIL_ATTEMPT_KINDS`, the single list `src/notify/kinds.ts` keeps and
 * `test/kinds.test.ts` holds to the modules' own constants.
 *
 * That list is sent to the database rather than restated in SQL. `email_usage()` (0026) takes the
 * kinds as an argument for exactly that reason: #37's fan-out found three stores each keeping
 * their own copy and disagreeing, and a fourth copy in a migration would be the one nothing holds
 * to the others.
 *
 * ## The count comes back through a definer, not a select
 *
 * 0010 revoked `notification_log` from `anon` and `authenticated` and enabled RLS with no policy,
 * so the cookie-bound client this page uses cannot read a single row of it — which is correct: the
 * log names who was emailed at what address. `email_usage()` is `security definer` and refuses a
 * non-admin with 42501, so the admin gets a COUNT and never a row, and the database decides a
 * second time what the page's `notFound()` decided first. Same arrangement as the invite code
 * (0003), and the reason `src/admin/load.ts` gives for not reaching for `supabaseAdmin()` here.
 *
 * ## Thresholds are a percentage of the cap, in integer arithmetic
 *
 * AC 1 asks for amber at 70 and red at 90 — of a 100 cap, so the rule is a percentage, and the
 * monthly 3,000 gets the same rule rather than a second pair of literals.
 *
 * `count * 100 >= cap * pc` rather than `count >= cap * (pc / 100)`, and the honest reason is
 * weaker than it looks: *measured* 2026-09-20, the two forms agree at every threshold for every
 * cap from 1 to 5,000 at both 70% and 90%, this app's two caps included — `3000 * 0.7` is exactly
 * 2100 in IEEE 754. So the integer form fixes no bug that exists here. It is kept because it
 * cannot be wrong for a cap nobody has tried, at no cost; the claim it must NOT carry is that it
 * was repairing something, which is what the first draft of this comment said before the test
 * written to prove it came back green.
 */

type Client = Awaited<ReturnType<typeof supabaseServer>>;

/** Amber from 70% of a cap, red from 90%. One rule, both caps. */
export const AMBER_PERCENT = 70;
export const RED_PERCENT = 90;

export type UsageLevel = "ok" | "amber" | "red";

export type EmailUsage = {
  day: number;
  month: number;
  dayCap: number;
  monthCap: number;
  /** UTC midnight the day count starts at — printed so the note can say which day it means. */
  dayStart: Date;
  monthStart: Date;
  /** Null unless the read itself failed; the screen says so rather than printing a zero. */
  error: string | null;
};

/**
 * Where a count sits against its cap. Note the ordering: red is tested first, so 90 of 100 is red
 * and not amber-because-it-is-also-over-70.
 */
export function usageLevel(count: number, cap: number): UsageLevel {
  if (count * 100 >= cap * RED_PERCENT) return "red";
  if (count * 100 >= cap * AMBER_PERCENT) return "amber";
  return "ok";
}

/**
 * The single RPC behind the screen. Both counts are decided at the instant the page was rendered
 * at — `now` comes from the page's one clock — so the day and the month cannot straddle a
 * boundary differently from each other or from the rest of the page.
 *
 * A failed read returns zeros WITH the error set. The screen prints the failure; it must never
 * print "0 of 100" for a read that did not happen, which is the reassuring answer and the one
 * that would let the cap arrive unannounced.
 */
export async function loadEmailUsage(client: Client, now: Date): Promise<EmailUsage> {
  const dayStart = emailDayStart(now);
  const monthStart = emailMonthStart(now);
  const base = { dayCap: EMAIL_DAY_CAP, monthCap: EMAIL_MONTH_CAP, dayStart, monthStart };

  const { data, error } = await client.rpc("email_usage", {
    p_kinds: EMAIL_ATTEMPT_KINDS as string[],
    p_day_start: dayStart.toISOString(),
    p_month_start: monthStart.toISOString(),
  });

  if (error) return { ...base, day: 0, month: 0, error: error.message };

  // `returns table` over PostgREST is an array of rows, and a definer that raised would have come
  // back as `error` above — so an empty array here would mean the function returned no row at all,
  // which it cannot. Treated as a failure rather than as zero, for the reason above.
  const row = (data as { day_count: number; month_count: number }[] | null)?.[0];
  if (!row) return { ...base, day: 0, month: 0, error: "email_usage returned no row" };

  return { ...base, day: row.day_count, month: row.month_count, error: null };
}
