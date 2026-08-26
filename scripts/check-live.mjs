#!/usr/bin/env node
/**
 * check:live — does the live Supabase project match the repo's migrations?
 *
 * Read-only by construction: every table probe is a PostgREST GET with `limit=0`, and every
 * function probe is a GET on `/rpc/<fn>`, which PostgREST serves in a read-only transaction —
 * so a function that writes is stopped by Postgres (25006) before it changes anything, whatever
 * the arguments are (cairn: postgrest-probing-a-live-project-2026-08-16). Needs
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment (.env.local,
 * gitignored).
 *
 * This file is deliberately thin, and the thinness is the design. Everything that decides an
 * outcome — the classifiers, the negative control per family that must read ABSENT before
 * anything is reported, and the handling of a request that never arrives — lives in
 * check-live-core.mjs, where it is unit-tested against fixture bodies with no live project.
 * What is expected lives in check-live-expected.mjs, where the hygiene test holds it equal to
 * the migrations and to the client's RPC calls. What is left here is the environment and the
 * real `fetch`, which is the one thing a test cannot supply.
 */
import { makeFunctionProbe, makeProbe, runCheck } from "./check-live-core.mjs";
import { EXPECTED_FUNCTIONS, EXPECTED_TABLES } from "./check-live-expected.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("check:live: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  // The one immediate exit that survives, and it is safe for a reason that must hold if it is
  // ever moved: NOTHING HAS BEEN FETCHED YET. Nothing below this line may exit immediately —
  // see the note above the exitCode assignment.
  process.exit(2);
}

const { code, lines } = await runCheck({
  probe: makeProbe({ fetchImpl: fetch, baseUrl: url, key }),
  tables: EXPECTED_TABLES,
  probeFunction: makeFunctionProbe({ fetchImpl: fetch, baseUrl: url, key }),
  functions: EXPECTED_FUNCTIONS,
});
for (const line of lines) console.log(line);

// Set the code and let the event loop drain. DO NOT call an immediate exit here, however
// obviously equivalent it looks.
//
// An immediate exit tears the process down while undici still holds the keep-alive socket the
// probes opened, and on Windows/Node 24 libuv aborts closing a handle that is already closing:
//
//     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
//
// The abort replaces the computed code with the crash code — 0xC0000409 raw, reported as 127 by
// npm and by a shell — so a run that reached its subject and answered correctly reports failure.
// That is the exact mirror of the vacuous pass check-live-core.mjs was written to refuse.
//
// #49 recorded this as intermittent, 5 runs in 32. Measured 2026-08-23 against the live project,
// one fresh process per run, it is not intermittent at all — it is a step function in HOW MANY
// REQUESTS PRECEDED THE EXIT, and only the first one is exposed:
//
//   requests before an immediate exit    1 -> 30/30 aborted    2 -> 0/30    3 -> 0/30    5 -> 0/30
//
// Same host, same key, same shape; nothing varies but the count. HTTP status is irrelevant —
// one request aborted 20/20 on a 200 and 20/20 on the gateway's 401.
//
// So the exposure is not spread thinly over every run. It sits entirely on the paths that exit
// after ONE probe, and in runCheck that is the key-rejected early return — measured 30/30
// aborted before this change and 0/30 after, on the real project. The other verdicts each make
// thirteen or more requests and did not abort in 20 runs apiece:
//
//   every table present (code 0)      0/20 aborted    a table missing (code 1)   0/20 aborted
//   key rejected      (code 2)       20/20 aborted
//
// Do not read that as "the healthy path is fine". It is one request away from the cliff, and
// nothing about EXPECTED_TABLES guarantees it stays above it: shrink the expected set, or add
// an early return above the loop, and the healthy path is back on 1 request and back to 30/30.
// That fragility is the argument for fixing the exit rather than the request count.
//
// The guard for this lives in test/check-live-exit.test.ts and is a SOURCE-TEXT test rather
// than a run, because no runnable harness here can see the abort: it needs a socket to a REMOTE
// host, and against localhost it did not reproduce in any arm — this runner over TLS 0/30 with
// the defect present, a bare fetch 0/20 over TLS and 0/40 over plain HTTP. CI has no live
// credentials, so a green step there would be evidence about nothing.
process.exitCode = code;
