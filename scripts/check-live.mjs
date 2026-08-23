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
  process.exit(2);
}

const { code, lines } = await runCheck({
  probe: makeProbe({ fetchImpl: fetch, baseUrl: url, key }),
  tables: EXPECTED_TABLES,
  probeFunction: makeFunctionProbe({ fetchImpl: fetch, baseUrl: url, key }),
  functions: EXPECTED_FUNCTIONS,
});
for (const line of lines) console.log(line);
process.exit(code);
