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
  now: Date;
};

export type TickResponse = {
  status: number;
  body: { posts: number; newSuggestions: number } | { error: string };
};

export async function handleTick(deps: TickHandlerDeps): Promise<TickResponse> {
  const { authorization, cronSchedule, secret, repo, dispatch, recordRun, now } = deps;
  if (!bearerAuthorized(authorization, secret)) return { status: 401, body: { error: "unauthorized" } };

  const result = await runTick(repo, now);

  // Only posts this pass newly reached somebody. A post whose rung did not move has nobody new
  // to tell, and dispatching it anyway would retry a permanently failing address on every tick —
  // each retry logged as an attempt, and attempts are what Resend's 100/day cap counts. A send
  // that failed is retried by the next post or availability toggle on that date (story #23's
  // rule), not by the clock.
  for (const ticked of result.ticked) {
    if (ticked.reached.length > 0) await dispatch(ticked.post);
  }

  await recordRun(tickRunRow(now, tickCaller(cronSchedule)));
  return { status: 200, body: { posts: result.posts, newSuggestions: result.newSuggestions } };
}
