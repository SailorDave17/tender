import { bearerAuthorized } from "@/auth/bearer";
import { runTick, type TickPost, type TickRepo } from "./tick";

/**
 * Everything /api/ladder/tick decides, with the request reduced to the headers it reads and
 * every effect injected (story #25 AC 5). The route itself is the binding to Next and nothing
 * else, so the 401, the order of the writes and the body's shape are unit-tested rather than
 * asserted against the route's source.
 *
 * ORDER IS THE CLAIM. AC 5 asks that an unauthorised call leave the repo untouched, which is not
 * a property of any single line — it is the fact that the refusal happens before `runTick` is
 * reached. A test proves it by handing in a repo that records every call and asserting it
 * recorded none, which is a stronger statement than "the response was 401".
 *
 * The stamp goes LAST. `tick_run.last_at` means "the last tick that finished its work", so a run
 * that throws part-way leaves the previous stamp standing and /admin goes on aging — which is
 * what the owner needs to see. Stamping first would make a crash-looping tick look healthy. The
 * daily sweep's stamp (#145) rides in the same write, so the same rule covers it.
 *
 * TWO CLOCKS, ONE ROUTE (#145). pg_cron calls every 15 minutes and Vercel's cron once a day, and
 * both used to write the same `last_at` — so the daily call was overwritten within 15 minutes and
 * its only other trace was a function-log line Vercel Hobby keeps for one hour. `sweep_at` (0019)
 * is stamped only when Vercel's cron is the caller, so the second clock stays readable for days.
 *
 * THE CLOCK IS WHAT RETRIES A PENDING SEND (#128 AC 5), and saying so is the point of this
 * paragraph: the two halves of this were each correct on their own, and nothing owned the seam.
 * `dispatchPending()` (src/notify/rung.ts) leaves `notified_at` NULL on a send the provider
 * refused and on one skipped at the day's cap, so that "the next call retries that person alone".
 * Until #128 the next call never came from here — the handler dispatched a post only when the
 * pass had reached somebody NEW, and a cap-skipped person is in `suggestion` from the pass that
 * skipped them, so they are never new again. The pending row waited on a post-create or an
 * availability toggle on that date, and if nobody else marked the day it waited forever. The
 * fifteen-minute schedule made it worse rather than better: ninety-six passes a day, every one of
 * them finding nobody new and skipping dispatch, and the pass that would resend after the cap
 * clears at UTC midnight is precisely one of those.
 *
 * So: the clock retries, on `TickedPost.pending`. The post-create and availability-toggle call
 * sites still dispatch as they always did — this adds a caller, it does not move the
 * responsibility. What it costs is that a permanently failing address IS now retried on every
 * tick, each attempt counting against Resend's 100/day cap, which this file previously called out
 * as the reason not to do it (owner decision, 2026-09-18, on #128: the systematic cap case is
 * worth more than the pathological address case). If that cost ever bites, the discriminator is
 * already in the ledger — a cap skip logs `rung_email_skipped_cap` and a refusal logs `rung_email`
 * with an `error` — so the condition can be narrowed to the former without a schema change.
 */

/**
 * The header that decides who called (#145 AC 3; owner decision 2026-09-13). Vercel documents it
 * on every cron invocation, carrying the expression that fired it — `0 12 * * *` here, from
 * `vercel.json`. pg_net's POST never carries it, and neither does a curl or a browser GET made with
 * the secret.
 *
 * Rejected: the METHOD. The route binds GET and POST to one handler because pg_net only posts and
 * Vercel only gets, but every other authorised GET — a debugging curl, a browser — would then be
 * recorded as the sweep. Also rejected: the `vercel-cron/1.0` user agent, which Vercel documents
 * just as firmly but which any client can send.
 *
 * NOT MEASURED: whether the dashboard's manual Run carries this header. If it does, a manual Run
 * moves `sweep_at` too. #145's last criterion still separates the two, because it reads the stamp
 * inside a scheduled 12:00–13:00 UTC window, when nobody presses Run.
 */
export const VERCEL_CRON_HEADER = "x-vercel-cron-schedule";

/** `other` is pg_cron's quarter-hour POST, or anyone else holding the secret. */
export type TickCaller = "vercel-cron" | "other";

export function tickCaller(cronSchedule: string | null): TickCaller {
  return cronSchedule !== null && cronSchedule.trim() !== "" ? "vercel-cron" : "other";
}

/**
 * The one `tick_run` row a finished tick writes. `sweep_at` is ABSENT, not null, for every caller
 * but Vercel's cron: the upsert updates only the columns it is given, so leaving the key out is
 * what keeps the previous daily stamp standing through the 95 quarter-hour ticks between sweeps.
 * A null here would erase it.
 */
export type TickRunRow = { id: 1; last_at: string; sweep_at?: string };

export function tickRunRow(now: Date, caller: TickCaller): TickRunRow {
  const at = now.toISOString();
  return caller === "vercel-cron" ? { id: 1, last_at: at, sweep_at: at } : { id: 1, last_at: at };
}

export type TickHandlerDeps = {
  /** The request's `Authorization` header, verbatim. */
  authorization: string | null;
  /** The request's `x-vercel-cron-schedule` header, verbatim (see VERCEL_CRON_HEADER). */
  cronSchedule: string | null;
  /** `process.env.CRON_SECRET`. Absent refuses everything (src/auth/bearer.ts). */
  secret: string | undefined;
  repo: TickRepo;
  /** Send to whoever this post now has pending. Per post, and never allowed to fail the tick. */
  dispatch: (post: TickPost) => Promise<void>;
  /** Upsert the row into `tick_run` (0012, 0019). */
  recordRun: (row: TickRunRow) => Promise<void>;
  /**
   * The morning-of pass (#37): ask every crew whose race morning it is to confirm. Runs after
   * the ladder's dispatch and before the stamp, so it rides the same clock and the same rule —
   * a pass that throws leaves `tick_run` unmoved. Per-match failures are the live wrapper's to
   * swallow (src/notify/live.ts), the same way `dispatch` is.
   */
  morningOf: (now: Date) => Promise<void>;
  now: Date;
};

export type TickResponse = {
  status: number;
  body: { posts: number; newSuggestions: number } | { error: string };
};

export async function handleTick(deps: TickHandlerDeps): Promise<TickResponse> {
  const { authorization, cronSchedule, secret, repo, dispatch, recordRun, morningOf, now } = deps;
  if (!bearerAuthorized(authorization, secret)) return { status: 401, body: { error: "unauthorized" } };

  const result = await runTick(repo, now);

  // Every post with anything OWED a send, not only the ones this pass reached somebody new on
  // (#128). `dispatchPending()` sends to whoever is pending and nobody else, so handing it a post
  // twice sends nothing twice; what it cannot do is send to a post it is never handed.
  for (const ticked of result.ticked) {
    if (ticked.pending) await dispatch(ticked.post);
  }

  // The race morning's reminders (#37), on the same clock. After the ladder, so a crew reached
  // by this very pass is not asked to confirm a match that does not exist yet; before the stamp.
  await morningOf(now);

  await recordRun(tickRunRow(now, tickCaller(cronSchedule)));
  return { status: 200, body: { posts: result.posts, newSuggestions: result.newSuggestions } };
}
