#!/usr/bin/env node
/**
 * check:live — does the live Supabase project match the repo's migrations?
 *
 * Read-only by construction: every probe is a PostgREST GET with `limit=0`, which runs in a
 * read-only transaction whatever the arguments are (cairn: postgrest-probing-a-live-project-
 * 2026-08-16). Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the
 * environment (.env.local, gitignored). Prints one line per expected table and exits non-zero
 * on any miss — an empty expected set would be vacuous, so the list is asserted non-empty.
 *
 * Classification: a PGRST205 means PostgREST never found the table (absent). A 401/permission
 * error means the table resolved and the anon role is refused — which is PRESENT and correct
 * for a table with no anon policy. Anything else is UNPROVEN, never a pass.
 */
const EXPECTED_TABLES = ["club"];

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("check:live: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
  process.exit(2);
}
if (EXPECTED_TABLES.length === 0) {
  console.error("check:live: expected set is empty — refusing a vacuous pass");
  process.exit(2);
}

let failures = 0;
for (const table of EXPECTED_TABLES) {
  const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const body = await res.text();
  let verdict;
  if (res.ok) verdict = "PRESENT (anon can read)";
  else if (body.includes("PGRST205")) verdict = "ABSENT (PGRST205)";
  else if (res.status === 401 || res.status === 403 || /permission denied/.test(body))
    verdict = "PRESENT (anon refused — expected for club)";
  else verdict = `UNPROVEN (${res.status}: ${body.slice(0, 80)})`;
  const ok = verdict.startsWith("PRESENT");
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${table}: ${verdict}`);
}
console.log(`check:live: ${EXPECTED_TABLES.length - failures}/${EXPECTED_TABLES.length} present`);
process.exit(failures ? 1 : 0);
