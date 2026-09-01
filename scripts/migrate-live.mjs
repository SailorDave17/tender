#!/usr/bin/env node
/**
 * Apply one migration file to the live project — story #114.
 *
 *     npm run migrate:live supabase/migrations/0015_anon_revoke.sql
 *     npm run migrate:live supabase/migrations/0015_anon_revoke.sql -- --dry-run
 *
 * WHAT IT DOES THAT A PASTE CANNOT
 *
 * It proves the payload arrived. On this machine a clipboard can re-encode a file, and the
 * characters most likely to be hit are the ones inside `comment on ... is '...'` literals, which
 * persist into the database as schema documentation (cairn: windows-shell-hazards hazard 24 —
 * `clip.exe` puts a cp1252 round trip on the clipboard). This asks POSTGRES for the length and
 * md5 of what it received, BEFORE applying anything, and refuses on a mismatch. A file compared
 * against itself would prove nothing.
 *
 * WHY IT ONLY TAKES A FILE FROM `supabase/migrations/`
 *
 * Because the thing a personal access token makes easy is the thing worth not building: a general
 * "run this SQL against production" command puts an unreviewed statement one typo away from the
 * live project. A path outside that directory is refused here rather than sent.
 *
 * WHY THERE IS NO ARE-YOU-SURE PROMPT
 *
 * A prompt would defeat the point, which is a command that can run with nobody watching. What
 * stands in for it is `--dry-run`, the directory restriction above, and the fact that DECIDING to
 * apply is still the owner's. Applying a migration remains a deliberate act with a sequence:
 * apply, then confirm with `npm run check:live`.
 *
 * This file is deliberately thin in the same way `check-live.mjs` is: everything that decides an
 * outcome is a pure function tested with an injected `fetch` and no live project, and what is left
 * here is the environment and the real transport, which is the one thing a test cannot supply.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  Refusal,
  compareEcho,
  echoQuery,
  isReadOnlyRefusal,
  localBytes,
  localChars,
  localDigest,
  projectRefFrom,
  readEnvLocal,
  requireAccessToken,
  resolveAccessToken,
  resolveSupabaseUrl,
  runQuery,
  splitStatements,
  TOKEN_PAGE,
  TOKEN_VAR,
} from "./management-api.mjs";

/** The one directory a file may come from. */
export const MIGRATIONS_DIR = "supabase/migrations";

/** Every flag this command understands. Anything else is refused, never ignored. */
export const KNOWN_FLAGS = Object.freeze(["--dry-run"]);

/**
 * Was a rehearsal asked for? — and the answer is NOT just `process.argv`.
 *
 * `npm run` EATS a flag it recognises. `npm run migrate:live 0015.sql --dry-run` forwards only
 * `["0015.sql"]` to the script and sets `npm_config_dry_run="true"` in the environment, because
 * npm has a `--dry-run` of its own and claims it first. So the natural spelling — the one a person
 * types — arrives here with no flag at all, and would perform a REAL, irreversible apply while the
 * operator believed they had asked for a rehearsal.
 *
 * Reading npm's variable as well as `argv` is what makes both spellings work. The flag a user
 * typed is the fact; which of the two channels carried it is npm's business.
 *
 * It fails toward the SAFE side by construction — a stray `npm_config_dry_run` in the environment
 * makes this rehearse when it might have applied, which costs a re-run and nothing else.
 */
export function dryRunRequested(argv, env = {}) {
  if (argv.includes("--dry-run")) return true;
  const fromNpm = String(env.npm_config_dry_run ?? "").toLowerCase();
  return fromNpm === "true" || fromNpm === "1";
}

/**
 * REFUSE a flag this command does not know, rather than dropping it.
 *
 * `migrationFileFrom` filters `-`-prefixed arguments out when looking for the file, which is right
 * for finding a file and silently wrong for everything else: without this, `--dry-rnu`, `--dryrun`
 * and `--pretend` would all be discarded without a word and the run would apply for real. A
 * mistyped safety flag must be the loudest thing in the output, because the person who typed it is
 * by definition the person expecting nothing to happen.
 */
export function assertKnownFlags(argv) {
  const unknown = argv.filter((arg) => arg.startsWith("-") && !KNOWN_FLAGS.includes(arg));
  if (unknown.length) {
    throw new Error(
      `Unknown flag: ${unknown.join(", ")}\n\n` +
        `This command understands ${KNOWN_FLAGS.join(", ")} and nothing else.\n\n` +
        "Refusing rather than ignoring it, because the flag people mistype here is\n" +
        "the one that stops the migration being applied — and a silently dropped\n" +
        "`--dry-run` is a real apply that the operator thinks is a rehearsal.\n\n" +
        "Note that `npm run` claims flags for itself, so a rehearsal is either\n" +
        `    npm run migrate:live ${MIGRATIONS_DIR}/0015_anon_revoke.sql -- --dry-run\n` +
        `    npm run migrate:live ${MIGRATIONS_DIR}/0015_anon_revoke.sql --dry-run\n` +
        "and both are understood.\n\n" +
        "Nothing was sent and nothing was changed.",
    );
  }
  return argv;
}

/**
 * Which file this invocation should apply.
 *
 * REFUSES four things, and the third is the narrowing that keeps this from becoming the general
 * command argued against above: no argument at all, more than one, a path outside
 * `supabase/migrations/`, and a file that is not `.sql`.
 *
 * The comparison is done on the RESOLVED path rather than the string, so
 * `supabase/migrations/../../etc/passwd` is refused too — a check against the text would pass it,
 * and the whole value of the restriction is that it cannot be talked around.
 */
export function migrationFileFrom(argv, cwd = process.cwd()) {
  const named = argv.filter((arg) => !arg.startsWith("-"));

  if (named.length === 0) {
    throw new Error(
      "Name the migration to apply.\n\n" +
        `    npm run migrate:live ${MIGRATIONS_DIR}/0015_anon_revoke.sql\n\n` +
        "This command takes a FILE, never SQL. A general \"run this against\n" +
        "production\" command is the thing a personal access token makes easy and the\n" +
        "thing #114 deliberately did not build.",
    );
  }
  if (named.length > 1) {
    throw new Error(
      `One file at a time. Given: ${named.join(", ")}\n\n` +
        "Migrations have an order, and applying two in one call would hide which of\n" +
        "them failed.",
    );
  }

  const [given] = named;
  const absolute = resolve(cwd, given);
  const within = relative(resolve(cwd, MIGRATIONS_DIR), absolute).split("\\").join("/");

  if (within.startsWith("..") || within === "" || within.includes("/")) {
    throw new Error(
      `Not a migration: ${given}\n\n` +
        `This command applies a file from \`${MIGRATIONS_DIR}/\` and nothing else. The\n` +
        "restriction is the point rather than an inconvenience — see the header of\n" +
        "scripts/migrate-live.mjs, and #114.",
    );
  }
  if (!/\.sql$/i.test(absolute)) {
    throw new Error(`Not a .sql file: ${given}`);
  }

  return absolute;
}

/**
 * The lines this prints before it sends anything.
 *
 * Split out from the runner so a test can read them without a network, and so `--dry-run` and a
 * real run print the SAME plan — a dry run that formats its own summary is a dry run that can
 * disagree with the thing it is rehearsing.
 */
export function planLines({ ref, path, sql }) {
  return [
    `project    : ${ref}   (derived from NEXT_PUBLIC_SUPABASE_URL)`,
    `file       : ${path}`,
    `statements : ${splitStatements(sql).length}`,
    `characters : ${localChars(sql)}   bytes: ${localBytes(sql)}`,
    `md5        : ${localDigest(sql)}`,
  ];
}

/**
 * Apply the file, having first made the database describe what it received.
 *
 * Two round trips, in this order, and the order is the whole design:
 *
 *   1. the ECHO — read-only. Embeds the payload in a dollar-quoted literal and asks Postgres for
 *      its length, byte count and md5. Nothing is applied. A mismatch here means the payload was
 *      mangled in transit, and the run stops with the file untouched at the far end.
 *   2. the APPLY — only reached once the payload is known to have arrived whole.
 *
 * Returns a result object rather than printing, so the whole decision path is testable with an
 * injected `fetch` and no live project.
 */
export async function applyMigration({ ref, token, sql, fetchImpl }) {
  // `readOnly: true` on the echo is not decoration. The stage's whole claim is that it inspects
  // without applying, and until now that rested on the SQL being a SELECT — a property a later
  // edit to `echoQuery` could quietly lose. Asking the platform to enforce it makes the
  // harmlessness a property of the REQUEST rather than of an argument somebody has to get right
  // (cairn: postgrest-probing-a-live-project — prefer the probe whose harmlessness cannot be
  // undone by getting an argument wrong).
  const echo = await runQuery({ ref, token, sql: echoQuery(sql), readOnly: true, fetchImpl });
  if (!echo.ok) {
    return { ok: false, stage: "echo", error: echo.error, applied: false };
  }

  const received = echo.rows?.[0] ?? null;
  const problems = compareEcho(sql, received);
  if (problems.length) {
    return { ok: false, stage: "echo", problems, received, applied: false };
  }

  const apply = await runQuery({ ref, token, sql, readOnly: false, fetchImpl });
  if (!apply.ok) {
    // Deliberately says the payload was fine. Without that, a migration whose SQL is simply wrong
    // reads as a transport problem, and somebody goes looking at the wire instead of at the file.
    return { ok: false, stage: "apply", error: apply.error, received, applied: false };
  }

  return { ok: true, stage: "apply", received, applied: true, rows: apply.rows };
}

// `pathToFileURL` rather than string-building the URL: on Windows `import.meta.url` is
// `file:///C:/...` with three slashes while a hand-built `file://` + path has two, so the
// comparison silently fails, this block never runs, and the script exits 0 having applied nothing
// — which is the precise failure it exists to prevent (cairn:
// a-command-in-prose-is-not-a-capability-2026-08-20).
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

/**
 * `readEnv` is injected for the same reason `fetchImpl` is: without it this function reaches the
 * real `.env.local`, and a test asserting "no token is refused" would silently start passing a
 * REAL token the day the owner adds one — a test whose verdict depends on the machine's
 * credential state rather than on the code. It defaults to the real reader, so the command itself
 * is unchanged.
 */
export async function main(argv, env, out = console, readEnv = readEnvLocal) {
  const refuse = (message) => {
    throw new Refusal(message);
  };

  let ref;
  try {
    ref = projectRefFrom(resolveSupabaseUrl(env, readEnv));
  } catch (error) {
    refuse(`Cannot work out which project to apply to.\n\n${error.message}`);
  }

  // Flags first, and before anything is read or resolved: a mistyped `--dry-run` has to be refused
  // whatever else is wrong with the invocation.
  assertKnownFlags(argv);

  const path = migrationFileFrom(argv);

  let sql;
  try {
    sql = readFileSync(path, "utf8");
  } catch (error) {
    refuse(`Cannot read ${path}\n\n${error.message}`);
  }

  const shown = relative(process.cwd(), path).split("\\").join("/");
  out.log("");
  for (const line of planLines({ ref, path: shown, sql })) out.log(line);
  out.log("");

  if (dryRunRequested(argv, env)) {
    out.log("--dry-run: nothing was sent and nothing was applied.\n");
    return { dryRun: true };
  }

  // The token is required AFTER the plan is printed and BEFORE anything is sent, so a dry run
  // needs no credential at all — which is what makes it useful to somebody checking what a command
  // would do before deciding to hold one.
  const token = requireAccessToken(resolveAccessToken(env, readEnv));

  const result = await applyMigration({ ref, token, sql, fetchImpl: fetch });

  if (!result.ok && result.stage === "echo" && result.problems) {
    refuse(
      "REFUSED: the database did not receive the file that is on disk.\n\n" +
        result.problems.map((line) => `  - ${line}`).join("\n") +
        "\n\nNothing was applied. This is the check that a clipboard paste needs a person\n" +
        "to do by hand, and it is the reason this command exists.",
    );
  }
  if (!result.ok && result.stage === "echo") {
    refuse(`The echo round trip failed, so nothing was applied.\n\n${result.error}`);
  }
  // The credential case FIRST, because the generic message below is wrong about it in both halves.
  // *Measured on this command's first real run*: `0015` arrived with a matching md5 and was refused
  // with 25006, and the message blamed the FILE — which had nothing wrong with it — and implied
  // transit, which the echo stage had just proven fine. A refusal naming the wrong subject is worse
  // than a bare failure, because it is followed.
  if (!result.ok && isReadOnlyRefusal(result.error)) {
    refuse(
      "REFUSED BY THE CONNECTION, NOT BY THE FILE.\n\n" +
        `${result.error}\n\n` +
        "The payload arrived intact — the echo stage compared it against the file on disk and they\n" +
        "matched — and Postgres then refused to WRITE. It raises 25006 for any write on a read-only\n" +
        "connection, whatever the statement, so this says nothing at all about the SQL.\n\n" +
        `The cause is the credential in ${TOKEN_VAR}. *Measured 2026-08-31*: a personal access\n` +
        "token that connects as `supabase_read_only_user` answers 25006 to every write and 201 to\n" +
        "every read, and the API's own `read_only` flag changes nothing in either direction — so\n" +
        "passing `read_only: false` is NOT evidence that a connection can write.\n\n" +
        `Check what this token is allowed to do:  ${TOKEN_PAGE}\n` +
        "Confirm the role it connects as:        select current_user;\n\n" +
        "Nothing was applied.",
    );
  }
  if (!result.ok) {
    refuse(
      "The payload arrived intact and Postgres REFUSED THE SQL, so the fault is in\n" +
        `the file rather than in transit.\n\n${result.error}`,
    );
  }

  // The two numbers printed from what the DATABASE said rather than from the file — a count read
  // back off the local copy would agree with itself whatever happened on the wire.
  out.log("applied.");
  out.log(`  statements sent     : ${splitStatements(sql).length}`);
  out.log(`  characters read back: ${result.received.chars}   (file: ${localChars(sql)})`);
  out.log(`  md5 read back       : ${result.received.digest}`);
  out.log("\nConfirm with:  npm run check:live\n");

  return result;
}

if (isMain) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    // No `process.exit()` anywhere on this path — see `Refusal` in management-api.mjs. The exit
    // code is SET and the event loop drains on its own, which is what keeps a refusal that follows
    // a single fetch from being replaced by a libuv abort. An unexpected error prints its stack; a
    // deliberate refusal prints only its message, because a stack under a carefully-worded refusal
    // sends the reader to the tool rather than to the token or the file.
    console.error(`\n${error instanceof Refusal ? error.message : (error?.stack ?? error)}\n`);
    process.exitCode = 1;
  }
}
