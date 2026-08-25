import { bearerAuthorized } from "@/auth/bearer";
import { runTick, type TickPost, type TickRepo } from "./tick";

/**
 * Everything /api/ladder/tick decides, with the request reduced to the one header it reads and
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
 * what the owner needs to see. Stamping first would make a crash-looping tick look healthy.
 */

export type TickHandlerDeps = {
  /** The request's `Authorization` header, verbatim. */
  authorization: string | null;
  /** `process.env.CRON_SECRET`. Absent refuses everything (src/auth/bearer.ts). */
  secret: string | undefined;
  repo: TickRepo;
  /** Send to whoever this post now has pending. Per post, and never allowed to fail the tick. */
  dispatch: (post: TickPost) => Promise<void>;
  recordRun: (now: Date) => Promise<void>;
  now: Date;
};

export type TickResponse = {
  status: number;
  body: { posts: number; newSuggestions: number } | { error: string };
};

export async function handleTick(deps: TickHandlerDeps): Promise<TickResponse> {
  const { authorization, secret, repo, dispatch, recordRun, now } = deps;
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

  await recordRun(now);
  return { status: 200, body: { posts: result.posts, newSuggestions: result.newSuggestions } };
}
