/**
 * The one reader of a server environment variable, and the one place a missing one is named
 * (story #65).
 *
 * Every server name the runbook asks for is read through here, so a deployment that skipped a
 * runbook step fails at construction with the variable's own name in the message rather than as
 * a bare 500. That is the whole story: on 2026-08-23 Vercel carried only the two public names,
 * `/api/join` threw before it could read the club row, and the form showed "Something went
 * wrong." with nothing anywhere naming `SUPABASE_SERVICE_ROLE_KEY`.
 *
 * Empty counts as unset. A Vercel variable created and left blank is the likelier mistake than
 * one never created at all, and the two are the same failure to the code that reads it.
 *
 * `read` is injectable so the assertion is a unit test with no network and no process mutation —
 * the same shape as the injected `now` in src/dates/race-date.ts and the injected key in
 * src/email/send.ts. It is NOT a second source of truth: production always reads process.env.
 * Typed as a plain record rather than NodeJS.ProcessEnv because a lookup is all this does, and
 * ProcessEnv demands NODE_ENV of every fixture for no benefit to the one line below.
 *
 * Deliberately no `server-only` import. src/proxy.ts runs in the request path before any route
 * and reaches for two of these names, and it is the earliest point at which one can be missing;
 * a module it cannot import would leave that site asserting nothing.
 *
 * The list of names itself lives in scripts/server-env.mjs, not here, because `npm run
 * check:live` is plain Node and cannot import TypeScript — and a second copy of the list is how
 * the instrument and the assertion drift apart. test/server-env.test.ts holds the two equal.
 */
export function env(name: string, read: Readonly<Record<string, string | undefined>> = process.env): string {
  const value = read[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
