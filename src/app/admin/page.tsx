import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadEmailUsage } from "@/admin/email-usage";
import { loadSeasonData } from "@/admin/load";
import { boatsWithoutCrew, countsByDate } from "@/admin/season";
import { seasonMetric } from "@/lib/metric";
import { supabaseServer } from "@/lib/supabase/server";
import { rotateInviteCode } from "./actions";
import { ClockPulse } from "./ClockPulse";
import { EmailUsage } from "./EmailUsage";
import { SeasonSummary } from "./SeasonSummary";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /admin — the club's invite code, and the one button that replaces it (story #16).
 *
 * The proxy has already sent anyone with no session to /join. A signed-in non-admin gets a
 * 404 (AC 2): the page exists for one person, and to everyone else it does not exist. The code
 * is read through current_invite_code() (0003) as the signed-in admin — the column itself is
 * withheld from every client role, and the function refuses a non-admin with 42501, so the
 * database decides twice what the 404 decided once.
 *
 * Rotate is two taps on purpose, both plain HTML forms: a GET that shows the confirmation
 * (?confirm=rotate), then the POST that rotates. A leaked code is what this page exists to
 * stop, and a mis-tap that rotates it locks out whoever was half-way through joining with the
 * old one — so the one-action rotation the charter asks for is one CONFIRMED action.
 *
 * Since #25 it also carries the ladder clock's pulse. That is the only reason `tick_run` (0012)
 * exists: a tick that never ran and a tick that ran and found nothing to do are the same
 * observation from inside the app — no email, no changed row — so without a stamp the clock's
 * death is silent for as long as nobody notices posts failing to widen. A missing row reads as
 * "never", which is the honest answer before the first tick and, after #26 wires the schedulers,
 * the loudest thing on the page. Since #145 the same row carries the daily sweep's own stamp
 * (`sweep_at`, 0019), printed beside it by `ClockPulse`.
 *
 * Since #38 it also carries the season: the charter's two headline numbers and a row per race
 * day linking to that day's detail screen. Those reads run as the signed-in admin like every
 * other read here, so RLS decides them a second time — see `src/admin/load.ts`.
 *
 * Since #39 it carries Resend's budget, which is ADR 007's promised consequence: the bet was that
 * email to the current rung fits inside 100 a day, and this is the only place that bet can be seen
 * losing before the mail stops. It is the one figure here the admin cannot get from the board.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ confirm?: string; rotated?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const { data: code, error: readError } = await client.rpc("current_invite_code");
  // 0012's one row, or none before the first tick. maybeSingle() so "never ticked" is a value
  // rather than an error — and note that a non-admin would read zero rows for a different
  // reason, which is why nothing but this admin-only page reads the table (0012's header).
  const { data: tick } = await client.from("tick_run").select("last_at, sweep_at").maybeSingle();
  const { confirm, rotated, error } = await searchParams;

  // One clock for the whole page: the counts, the metric and "elapsed" must all be decided at
  // the same instant, or a race day starting mid-render could be elapsed in one number and not
  // in the next.
  const now = new Date();
  const season = await loadSeasonData(client);
  const counts = countsByDate(season.dates, season.posts, season.matches, now);
  const metric = seasonMetric(season.matches, season.dates, now);
  // Through email_usage() (0026), not a select: 0010 withholds notification_log from every client
  // role, so the admin gets a count and never a row — the invite code's arrangement again.
  const usage = await loadEmailUsage(client, now);

  return (
    <main data-measure="wide">
      <h1>Admin</h1>
      <p>
        {/* /admin/dates has had a dynamic child since #38, so Next requires <Link> here. */}
        <a href="/board">Back to the board</a> · <Link href="/admin/dates">Race dates</Link> ·{" "}
        <a href="/admin/invite">Invite people</a> · <a href="/admin/people">People</a> ·{" "}
        <a href="/admin/theme">Theme</a> ·{" "}
        {/* /admin/threads has a dynamic child (#36), so Next requires <Link>, as for dates. */}
        <Link href="/admin/threads">Match threads</Link>
      </p>

      <h2>Ladder clock</h2>
      <ClockPulse
        lastAt={tick ? new Date(tick.last_at) : null}
        sweepAt={tick?.sweep_at ? new Date(tick.sweep_at) : null}
        now={now}
      />

      <h2>This season</h2>
      <SeasonSummary
        dates={season.dates}
        counts={counts}
        metric={metric}
        strandedBoats={boatsWithoutCrew(counts)}
      />

      <h2>Email budget</h2>
      <EmailUsage usage={usage} />

      <h2>Invite code</h2>
      <p>
        New people join at <code>/join</code> with this code. Rotating it stops the old code
        working immediately; anyone who has already signed in is unaffected.
      </p>
      {readError ? (
        <p role="alert">Could not read the invite code: {readError.message}</p>
      ) : (
        <p>
          Current code: <strong data-invite-code>{code as string}</strong>
        </p>
      )}
      {rotated && <p role="status">The invite code was replaced. Hand out the new one above.</p>}
      {error && <p role="alert">The code was not rotated: the database refused the change.</p>}

      {confirm === "rotate" ? (
        <form action={rotateInviteCode} style={{ display: "grid", gap: "0.75rem" }}>
          <p>
            <strong>Replace the invite code?</strong> The current code stops working the moment you
            confirm, including for anyone who has it but has not joined yet.
          </p>
          <input type="hidden" name="confirmed" value="yes" />
          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="submit" data-confirm-rotate>
              Yes, rotate it
            </button>
            <a href="/admin">Cancel</a>
          </div>
        </form>
      ) : (
        <form method="get" action="/admin">
          <input type="hidden" name="confirm" value="rotate" />
          <button type="submit" data-rotate>
            Rotate the invite code
          </button>
        </form>
      )}
    </main>
  );
}
