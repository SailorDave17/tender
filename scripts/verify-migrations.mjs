#!/usr/bin/env node
/**
 * verify:migrations — is the live project in the state `supabase/migrations/` describes? (#117)
 *
 *     npm run verify:migrations
 *
 * Reads the project ref from the public Supabase URL and the credential from the access-token
 * variable, both out of `.env.local`, which is gitignored. Neither name is spelled here: both come
 * from `management-api.mjs` as `URL_VAR` and `TOKEN_VAR`, so the token's name has one definition
 * in the repo and `test/migrate-live-scope.test.ts` can hold the list of files that mention it —
 * a second literal is a second thing to keep in step, and it refused this file until the literal
 * came out.
 *
 * This file is deliberately thin, in the same way `check-live.mjs` and `migrate-live.mjs` are:
 * everything that decides an outcome — the parser, the fold, the catalog reads, the controls and
 * the report — is in `verify-migrations-core.mjs`, where it is exercised against the pglite
 * harness and against fixture SQL with no live project. What is left here is the filesystem, the
 * environment and the real transport, which are the three things a test cannot supply.
 *
 * EVERY QUERY GOES WITH `read_only: true`, AND THAT IS NOT DECORATION. The Management API's
 * `read_only` flag decides which role the connection is made as: omitted, a write-capable token
 * connects as `postgres` with the transaction OPEN FOR WRITING (*measured 2026-08-31*, cairn:
 * supabase-management-api-tokens-2026-08-31). So a command that reads the catalog while holding
 * the token that applies migrations would, by saying nothing, be inspecting production over a
 * fully writable connection. Passing the flag makes the harmlessness a property of the REQUEST
 * rather than of every statement below happening to be a `select` — a property a later edit can
 * lose silently. `runQuery` defaults to `true`; it is passed anyway, so the intent is legible at
 * the call site and a test can assert it on the wire.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Refusal,
  TOKEN_PAGE,
  projectRefFrom,
  readEnvLocal,
  requireAccessToken,
  resolveAccessToken,
  resolveSupabaseUrl,
  runQuery,
} from "./management-api.mjs";
import { runVerify } from "./verify-migrations-core.mjs";

/** The one directory this reads, and it reads ALL of it — see #117's derived-not-listed criterion. */
export const MIGRATIONS_DIR = "supabase/migrations";

/**
 * Every migration on disk, in filename order, which is paste order.
 *
 * A glob rather than a list, because a list is the thing this command exists not to be: adding
 * `0016` must require no edit here, or the checker and the schema drift together while agreeing
 * with each other. An empty directory is refused upstream rather than passing as "nothing wrong".
 */
export function readMigrations(dir = MIGRATIONS_DIR, cwd = process.cwd()) {
  const root = resolve(cwd, dir);
  return readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(resolve(root, file), "utf8") }));
}

/** `runSql` for the real project: one Management API round trip, read-only, per query. */
export function makeRunSql({ ref, token, fetchImpl = fetch }) {
  return async (sql) => {
    const answer = await runQuery({ ref, token, sql, readOnly: true, fetchImpl });
    return { ok: answer.ok, rows: answer.rows ?? [], error: answer.error };
  };
}

export async function main(env, out = console, readEnv = readEnvLocal) {
  let ref;
  try {
    ref = projectRefFrom(resolveSupabaseUrl(env, readEnv));
  } catch (error) {
    throw new Refusal(`Cannot work out which project to read.\n\n${error.message}`);
  }

  const token = requireAccessToken(resolveAccessToken(env, readEnv));
  const migrations = readMigrations();

  out.log("");
  out.log(`verify:migrations — ${migrations.length} files in ${MIGRATIONS_DIR}/ against ${ref}`);
  out.log("reading pg_catalog with read_only: true; nothing here can write.");
  out.log("");

  const { code, lines } = await runVerify({ migrations, runSql: makeRunSql({ ref, token }) });
  for (const line of lines) out.log(line);
  if (code === 2) {
    out.log("");
    out.log(`If the credential is the problem, check what this token may do: ${TOKEN_PAGE}`);
  }
  return code;
}

// Windows/Node 24 aborts inside libuv on `process.exit()` after exactly one completed fetch,
// replacing the computed code with one a shell reports as 127 — command not found. Every refusal
// path above the first query is exactly that shape. So the code is SET and the loop drains, as in
// check-live.mjs and migrate-live.mjs (cairn: node-process-exit-after-fetch-2026-08-23).
// `pathToFileURL` rather than string-building the URL: on Windows `import.meta.url` is
// `file:///C:/...` with THREE slashes while a hand-built `file://` + path has two, so the
// comparison silently fails, this block never runs, and the command exits 0 having read nothing
// (cairn: a-command-in-prose-is-not-a-capability-2026-08-20).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(process.env);
  } catch (error) {
    console.error(`\n${error instanceof Refusal ? error.message : (error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}
