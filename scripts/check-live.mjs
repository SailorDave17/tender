#!/usr/bin/env node
/**
 * check:live — does the live Supabase project match the repo's migrations?
 *
 * Read-only by construction: every probe is a PostgREST GET with `limit=0`, which runs in a
 * read-only transaction whatever the arguments are (cairn: postgrest-probing-a-live-project-
 * 2026-08-16). Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the
 * environment (.env.local, gitignored).
 *
 * This file is deliberately thin, and the thinness is the design. Everything that decides an
 * outcome — the classifier, the negative control that must read ABSENT before any table is
 * reported, and the handling of a request that never arrives — lives in check-live-core.mjs,
 * where it is unit-tested against fixture bodies with no live project. What is left here is
 * the environment and the real `fetch`, which is the one thing a test cannot supply.
 */
import { makeProbe, runCheck } from "./check-live-core.mjs";

const EXPECTED_TABLES = ["club", "person", "person_contact"];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("check:live: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  process.exit(2);
}

const { code, lines } = await runCheck({
  probe: makeProbe({ fetchImpl: fetch, baseUrl: url, key }),
  tables: EXPECTED_TABLES,
});
for (const line of lines) console.log(line);
process.exit(code);
