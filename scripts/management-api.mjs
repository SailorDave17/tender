/**
 * The Supabase Management API, and the one command built on it — story #114.
 *
 * WHY THIS EXISTS
 *
 * Applying a migration was a browser paste, and nothing else. That is a real route and it stays
 * documented, but it serves an attended session and no cron, CI job or headless run — and, more
 * to the point here, it cannot prove what the database received. `POST
 * /v1/projects/{ref}/database/query` takes a bearer token instead, which is a thing a machine can
 * hold, and answers with rows a caller can compare against the file on disk.
 *
 * WHY THE SURFACE IS ONE NARROW COMMAND AND NOT A GENERAL ONE
 *
 * A general "run this SQL against production" command is the thing a token makes easy and the
 * thing worth not building: it puts an unreviewed statement one typo away from the live project.
 * So this module exports the transport, and `migrate-live.mjs` above it does exactly one thing —
 * apply a NAMED FILE from `supabase/migrations/`. Neither takes SQL from a person.
 *
 * WHAT A TOKEN OF THIS CLASS IS
 *
 * A Supabase personal access token has full authority over EVERY project in the account. Nothing
 * else this repo holds is like that: `NEXT_PUBLIC_SUPABASE_ANON_KEY` is public by design and
 * subject to RLS, and `SUPABASE_SERVICE_ROLE_KEY` is scoped to one project and authenticates to
 * that project's own API — PostgREST and GoTrue — which is why it cannot run DDL and is not an
 * alternative to this. The containment around the token — the refusals below, `.env.example`, the
 * `.env*` gitignore rule and the repo-wide scan in `test/migrate-live-scope.test.ts` — is as much
 * of #114 as the feature is.
 *
 * PORTED, NOT INVENTED. The design is Taskr's #185, and what is worth inheriting is one ordering
 * decision — the echo round trip comes first — plus three measured platform traps a fresh
 * implementation would have had to pay for before finding: npm eating `--dry-run`,
 * `process.exit()` aborting after exactly one fetch on Windows/Node 24, and a refusal printing a
 * whole `.env.local`. Adapted for this repo: the URL variable is `NEXT_PUBLIC_SUPABASE_URL`, and
 * the env/URL helpers live here rather than being borrowed from a deploy script tender does not
 * have.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A refusal this module makes on purpose, as opposed to a crash.
 *
 * It is a THROW rather than a `process.exit()`, and the second half of that is a platform fact
 * rather than taste: on Windows/Node 24, `process.exit()` after exactly ONE completed `fetch`
 * aborts inside libuv — `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` — replacing the
 * exit code with `0xC0000409`, which npm and a shell report as **127**, i.e. command-not-found.
 * The exposure is a step function in how many requests preceded the exit and only the first is
 * exposed (cairn: node-process-exit-after-fetch-2026-08-23, measured 30/30 at one request and
 * 0/30 at two).
 *
 * The path that fails after exactly one request is the echo-stage refusal — including `REFUSED:
 * the database did not receive the file that is on disk`, which is the reason this command exists
 * at all. So the single most important message it can print was the one at risk of being stapled
 * under a crash and reported to an unattended caller as a missing command. `scripts/check-live.mjs`
 * carries the same rule and the same reasoning; the repair (`process.exitCode` plus a natural
 * drain) is measured FASTER than the immediate exit, so there is no trade.
 */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

/** The variable this reads. The name the Supabase CLI uses, so one token serves both. */
export const TOKEN_VAR = "SUPABASE_ACCESS_TOKEN";

/** The variable the project ref is derived from — this repo's spelling. */
export const URL_VAR = "NEXT_PUBLIC_SUPABASE_URL";

/** Where the Management API lives. */
export const MANAGEMENT_API_ROOT = "https://api.supabase.com";

/** Where a personal access token is minted. Named in every refusal below. */
export const TOKEN_PAGE = "https://supabase.com/dashboard/account/tokens";

/** The most of a value any refusal here may quote back. */
export const REFUSAL_VALUE_LIMIT = 80;

/**
 * Everything a refusal is allowed to SAY about a value it was handed.
 *
 * A refusal is right to name what it saw; it must never say more than the one value it was asked
 * about. The failure this closes is concrete: a `projectRefFrom` refusal that interpolates its
 * argument prints the WHOLE of `.env.local` when the "value" it was handed is the entire file —
 * `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` included.
 *
 * Three rules, in order, each closing a different route to that:
 *
 *   1. ONE LINE. A value spanning lines is not one variable's value, so everything after the
 *      first newline is by construction something this function was not asked about.
 *   2. NO ASSIGNMENTS. If what arrived looks like env-file content — a line beginning `NAME=` —
 *      the VALUE is elided and the NAME kept. A caller that handed us a file needs to be told it
 *      handed us a file; it does not need the file read back to it. This is the rule that holds
 *      when the secret is on line ONE, which is exactly where rule 1 and the cap both fail.
 *   3. A LENGTH CAP, so one enormous line cannot fill a terminal.
 *
 * All three are STRUCTURAL: none carries a list of secret variable names, so none goes stale when
 * a new secret joins `.env.local`. Redacting BY NAME was the other candidate and was rejected
 * because a guard whose subject is what a variable is CALLED must be edited every time somebody
 * adds one, and the edit that gets forgotten is the silent one.
 *
 * A legitimate Supabase URL passes all three untouched, which is what keeps the refusal
 * diagnostic — asserted as a POSITIVE CONTROL, because a sanitiser that ate every value would
 * pass every leak test here while helping nobody.
 */
export function redactForRefusal(value) {
  const text = String(value ?? "");
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const deassigned = firstLine.replace(/^([ \t]*[A-Z][A-Z0-9_]{2,}[ \t]*=).*$/, "$1<redacted>");
  const capped =
    deassigned.length > REFUSAL_VALUE_LIMIT
      ? deassigned.slice(0, REFUSAL_VALUE_LIMIT) + "..."
      : deassigned;
  return capped === text ? capped : capped + " [truncated]";
}

/** `KEY=value` lines, enough for a `.env.local` and no more. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

/**
 * `https://abcdefgh.supabase.co` -> `abcdefgh`, refusing anything else.
 *
 * The refusal matters more here than for a read: applying a migration to the wrong project
 * succeeds, and is not undoable. A local stack (`127.0.0.1`) has no project ref, so it is refused
 * rather than guessed at — this command targets the hosted project only.
 */
export function projectRefFrom(url) {
  const value = String(url ?? "").trim();
  if (!value) throw new Error(`${URL_VAR} is not set.`);
  const match = value.match(/^https:\/\/([a-z0-9]{16,})\.supabase\.(co|in)\/?$/i);
  if (!match) {
    throw new Error(
      `${URL_VAR} is not a hosted Supabase project URL: ${redactForRefusal(value)}\n` +
        "A local stack (127.0.0.1) has no project ref — this command targets the hosted project only.",
    );
  }
  return match[1];
}

/** Reads `.env.local` from the working directory. Split out so tests can inject. */
export function readEnvLocal() {
  return readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
}

/** The environment first, then `.env.local`, which is gitignored and holds the real value. */
export function resolveSupabaseUrl(env, readFile) {
  if (env[URL_VAR]) return env[URL_VAR];
  try {
    return parseEnvFile(readFile())[URL_VAR] ?? "";
  } catch {
    return "";
  }
}

/** The same shape, reading a different key. */
export function resolveAccessToken(env, readFile) {
  if (env[TOKEN_VAR]) return String(env[TOKEN_VAR]).trim();
  try {
    return String(parseEnvFile(readFile())[TOKEN_VAR] ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * REFUSE rather than proceed, and refuse the near-misses BY NAME.
 *
 * Three failures, and the middle one is why this is a function rather than an `if`. An ABSENT
 * token is loud on its own: nothing works. A token that is really one of the other two Supabase
 * credentials is not, because both are to hand in `.env.local`, both are called a key, and
 * pasting either here produces a `401` from the Management API — a message about authentication,
 * which sends somebody to re-mint a token they already have rather than to look at what they
 * pasted.
 *
 * There is no fallback to a lesser credential. This throws, and the caller exits non-zero having
 * sent nothing: a script that carried on with the anon key would report success having done
 * nothing.
 */
export function requireAccessToken(token) {
  const value = String(token ?? "").trim();

  if (!value) {
    throw new Error(
      `${TOKEN_VAR} is not set, so there is nothing to authenticate with.\n\n` +
        "This command talks to the Supabase Management API, which takes a PERSONAL\n" +
        "ACCESS TOKEN — not the anon key, and not the service-role key. Mint one at\n" +
        `${TOKEN_PAGE} and put it in \`.env.local\`:\n\n` +
        `    ${TOKEN_VAR}=<the token>\n\n` +
        "It has authority over every project in the account. `.env.example` says what\n" +
        "that means and how to revoke it.\n\n" +
        "Nothing was sent and nothing was changed.",
    );
  }

  if (/^sb_publishable_/.test(value) || /^sb_secret_/.test(value)) {
    throw new Error(
      `${TOKEN_VAR} holds a PROJECT API KEY, not a personal access token.\n\n` +
        "The two sit near each other in the dashboard and are both called keys. A\n" +
        "project key authenticates to the project's own API (PostgREST, GoTrue); the\n" +
        "Management API is a different service and answers 401 — which reads as a bad\n" +
        "token rather than as the wrong KIND of credential.\n\n" +
        "A personal access token comes from the ACCOUNT page, not the project page:\n" +
        `${TOKEN_PAGE}\n\n` +
        "Nothing was sent and nothing was changed.",
    );
  }

  // A legacy JWT key — the older `anon`/`service_role` pair, which is what this repo's
  // `.env.local` still holds. The same mistake as above, and it has no memorable prefix to
  // recognise by eye, so recognising it here is worth more than recognising the modern one.
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) {
    throw new Error(
      `${TOKEN_VAR} holds a JWT, which is a legacy PROJECT key (\`anon\` or\n` +
        "`service_role`), not a personal access token. The same confusion as the\n" +
        "modern `sb_` pair, without a prefix to spot it by.\n\n" +
        `Mint a personal access token at ${TOKEN_PAGE}\n\n` +
        "Nothing was sent and nothing was changed.",
    );
  }

  return value;
}

/** The endpoint a query goes to, for one project. */
export function queryUrl(ref, root = MANAGEMENT_API_ROOT) {
  return `${root}/v1/projects/${ref}/database/query`;
}

/**
 * Run SQL against a project through the Management API.
 *
 * Returns `{ ok, status, rows, error }` rather than throwing on an HTTP failure, so the caller
 * decides what a given status means — the same reason `check-live-core.mjs` classifies by WHO
 * ANSWERED rather than by status code. An absent answer must never read as a clean one, so a
 * transport failure comes back with `ok: false` and `rows: null`, never as an empty result set
 * (cairn: an-absent-result-reads-as-a-clean-one-2026-08-11).
 */
export async function runQuery({ ref, token, sql, fetchImpl = fetch, root = MANAGEMENT_API_ROOT }) {
  let response;
  try {
    response = await fetchImpl(queryUrl(ref, root), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      rows: null,
      error: `the request never completed — ${error?.message ?? error}`,
    };
  }

  // INSIDE a try. Reading the body is a SECOND network operation: a connection reset mid-response
  // throws here, not at the `fetch` above, and the caller awaits this at top level — so an escape
  // becomes an unhandled rejection and the process dies, rather than the deliberate refusal this
  // module is built around.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      rows: null,
      error: `the response body could not be read — ${error?.message ?? error}`,
    };
  }

  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail =
      (parsed && (parsed.message || parsed.error || parsed.msg)) ||
      text.slice(0, 500) ||
      "(no body)";
    return {
      ok: false,
      status: response.status,
      rows: null,
      error: `[${response.status}] ${detail}`,
    };
  }

  return {
    ok: true,
    status: response.status,
    rows: Array.isArray(parsed) ? parsed : [],
    error: null,
  };
}

// -------------------------------------------------------------------------------------------
// Counting statements — the half that is a language problem
// -------------------------------------------------------------------------------------------

/**
 * The dollar-quote tag opening at `index`, or null.
 *
 * `$$` and `$name$` open one; `$1` does NOT — a tag must start with a letter or an underscore,
 * which is what stops a positional parameter being read as the start of a quoted region that
 * never ends.
 */
export function dollarTagAt(text, index) {
  if (text[index] !== "$") return null;
  if (text[index + 1] === "$") return "$$";
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(text.slice(index));
  return match ? match[0] : null;
}

/**
 * Split SQL into statements the way Postgres reads it, rather than the way `split(";")` does.
 *
 * Not pedantry about an edge case. `supabase/migrations/` is full of `plpgsql` bodies and every
 * one contains semicolons inside a `$$ ... $$` region, so a naive split reports `0012` as dozens
 * of statements and makes the count this prints worthless. All four things that hide a semicolon
 * are present in this repo's files:
 *
 *   - line comments introduced by two hyphens, running to the newline;
 *   - block comments, which NEST in Postgres unlike in C;
 *   - single-quoted strings, where a quote is escaped by DOUBLING it and never by a backslash;
 *   - dollar-quoted bodies, inside which nothing at all is special.
 *
 * Double-quoted identifiers are handled for the same reason, though nothing here uses one: a
 * scanner right for three of the four is a scanner whose failure waits for the first file that
 * uses the fourth.
 *
 * A trailing segment of nothing but whitespace and comments is not a statement, which is why
 * `sawCode` is tracked rather than segments being filtered on emptiness afterwards — a trailing
 * comment is not empty and is not a statement either.
 */
export function splitStatements(sql) {
  const text = String(sql ?? "");
  const out = [];
  let start = 0;
  let sawCode = false;
  let i = 0;

  const flush = (end) => {
    if (sawCode) out.push(text.slice(start, end));
    sawCode = false;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline + 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      sawCode = true;
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === quote) {
          // UNEXERCISED, deliberately, and this comment is the only thing stopping it read as
          // dead code. *Measured*: deleting these three lines changes the output of this function
          // on NOTHING — every migration in this repo and every fixture aimed at it. A doubled
          // quote is two quotes, so escaping it and closing-then-reopening end in the same state
          // and cover the same characters; no input can tell them apart (cairn:
          // a-zero-red-mutation-can-be-unreachable-2026-08-27). Kept because it is correct lexing
          // and becomes load-bearing the moment this scanner is asked for a string's SPAN rather
          // than for split points. `test/management-api.test.ts` carries the measurement.
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      const tag = dollarTagAt(text, i);
      if (tag) {
        sawCode = true;
        const end = text.indexOf(tag, i + tag.length);
        i = end === -1 ? text.length : end + tag.length;
        continue;
      }
    }

    if (ch === ";") {
      flush(i);
      i += 1;
      start = i;
      continue;
    }

    if (!/\s/.test(ch)) sawCode = true;
    i += 1;
  }

  flush(text.length);
  return out;
}

// -------------------------------------------------------------------------------------------
// Proving the payload arrived intact
// -------------------------------------------------------------------------------------------

/**
 * A dollar-quote tag that does not appear in `text`.
 *
 * Inside a dollar-quoted region Postgres treats everything as literal until it sees exactly the
 * same tag again, so a tag absent from the body makes the embedding safe whatever the body
 * contains — quotes, semicolons, other dollar-quotes and all. It REFUSES rather than truncating
 * if it cannot find one, because the failure of this function is a payload Postgres parses as
 * code.
 */
export function safeDollarTag(text, base = "tender_echo") {
  for (let n = 0; n < 100; n += 1) {
    const tag = `$${base}${n === 0 ? "" : n}$`;
    if (!String(text ?? "").includes(tag)) return tag;
  }
  throw new Error("cannot find a dollar-quote tag absent from this file");
}

/**
 * A read-only query asking Postgres to describe the payload IT received.
 *
 * The point is WHICH END does the reading. Comparing the file against itself would prove nothing
 * whatever. This embeds the payload, asks the DATABASE for its length and digest, and compares
 * those against the local file's — so the answer covers the whole path, and it is taken BEFORE
 * anything is applied. A mangled payload is refused rather than run.
 *
 * The hazard is measured rather than theoretical, and it is this machine's: `clip.exe` puts a
 * cp1252 round trip on the clipboard, and the casualties are the non-ASCII characters inside
 * `comment on ... is '...'` literals, which persist into the database as schema documentation
 * (cairn: windows-shell-hazards hazard 24). That is the check a paste needs a person to do by
 * hand, and the reason this command exists.
 *
 * `length()` counts characters in a UTF-8 database, which is why the local side counts code
 * points and not UTF-16 units. `md5()` is over the UTF-8 bytes, which is what `localDigest`
 * computes. The digest is the real check; the length is the one a person can read.
 */
export function echoQuery(sql) {
  const tag = safeDollarTag(sql);
  return (
    `with payload as (select ${tag}${sql}${tag}::text as body)\n` +
    "select length(body) as chars, md5(body) as digest, octet_length(body) as bytes\n" +
    "from payload;"
  );
}

/** Characters as Postgres counts them: code points, not UTF-16 units. */
export function localChars(text) {
  return [...String(text ?? "")].length;
}

/** `md5()` in Postgres is over the UTF-8 bytes of the text. */
export function localDigest(text) {
  return createHash("md5")
    .update(Buffer.from(String(text ?? ""), "utf8"))
    .digest("hex");
}

/** Bytes as `octet_length()` counts them. */
export function localBytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/**
 * Did the payload survive the trip?
 *
 * Returns a list of complaints, empty when it did. A list rather than a boolean because a length
 * mismatch and a digest mismatch mean different things — the first says characters were LOST, the
 * second says they were CHANGED, and a character-set round trip does the second while often
 * leaving the first intact.
 */
export function compareEcho(local, remote) {
  if (!remote || typeof remote !== "object") {
    return ["the database returned no description of what it received"];
  }

  const problems = [];
  const chars = Number(remote.chars);
  const bytes = Number(remote.bytes);
  const digest = String(remote.digest ?? "");

  if (chars !== localChars(local)) {
    problems.push(
      `the database received ${chars} characters, the file on disk has ` +
        `${localChars(local)} — characters were lost or added in transit`,
    );
  }
  if (bytes !== localBytes(local)) {
    problems.push(
      `the database received ${bytes} bytes, the file on disk is ${localBytes(local)} bytes`,
    );
  }
  if (digest !== localDigest(local)) {
    problems.push(
      `md5 differs: the database computed ${digest || "(none)"}, the file on disk is ` +
        `${localDigest(local)} — the bytes CHANGED even where the count did not, which is ` +
        "what a character-set round trip looks like",
    );
  }
  return problems;
}
