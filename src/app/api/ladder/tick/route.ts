import { NextResponse, type NextRequest } from "next/server";
import { recordTickRun, supabaseTickRepo } from "@/engine/tick-store";
import { handleTick } from "@/engine/tick-handler";
import { dispatchPendingLive } from "@/notify/live";

/**
 * /api/ladder/tick — the ladder clock's one entry point (story #25 AC 5).
 *
 * This file is the binding and nothing else: every decision is `handleTick()`, which is
 * unit-tested with the repo, the dispatch and the clock injected. The route's own job is to hand
 * it the `Authorization` header, the live adapters and the real time.
 *
 * GET AND POST BOTH ACT, which is unusual and deliberate: pg_cron's `net.http_post` sends POST
 * and Vercel Cron only ever issues GET (#26 wires both), so a safe-GET rule would leave the
 * second clock unable to call the first. The route is not reachable without the shared secret,
 * so nothing a crawler or a prefetch can do reaches the work.
 *
 * Not listed in `PROTECTED_PREFIXES` (src/auth/gate.ts) on purpose: a scheduler has no session
 * and would be redirected to /join by the proxy. Its credential is the bearer secret.
 */

export const dynamic = "force-dynamic";

async function tick(request: NextRequest): Promise<NextResponse> {
  const { status, body } = await handleTick({
    authorization: request.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    repo: supabaseTickRepo(),
    dispatch: dispatchPendingLive,
    recordRun: recordTickRun,
    now: new Date(),
  });
  return NextResponse.json(body, { status });
}

export const GET = tick;
export const POST = tick;
