/**
 * check:live's classifiers and run planner, extracted from the runner so both can be tested
 * against fixture bodies with no live project. `check-live.mjs` supplies the real probes and
 * does nothing else — everything that decides an outcome is here.
 *
 * Two families are probed, each with its own negative control: TABLES, read with `limit=0`,
 * and FUNCTIONS, called by GET (story #16 AC 3). A GET on `/rpc/<fn>` is served in a read-only
 * transaction, so a function that writes resolves, runs, and is stopped by Postgres with 25006
 * before it changes anything — which proves it exists in one round trip and is the
 * function-shaped equivalent of `limit=0` (cairn: postgrest-probing-a-live-project-2026-08-16).
 *
 * The classification is not a list of happy status codes. It is a question about WHO ANSWERED
 * (cairn: postgrest-probing-a-live-project-2026-08-16). Three parties can answer one GET:
 *
 *   the gateway     rejects the API key before Postgres or PostgREST is involved. 401, and the
 *                   body carries NO five-character SQLSTATE, because no database was reached.
 *   PostgREST       resolves the relation against its own schema cache. PGRST205 — the table is
 *                   not there. (42P01 is the same answer from the other side; accept both, since
 *                   only one of them is guessable — cairn: supabase-rls-column-grants-2026-08-06.)
 *   Postgres        ran the statement and refused it. 42501 — the table EXISTS and this role may
 *                   not read it, which for `club` is the correct and expected state.
 *
 * This module exists because the previous version read `res.status === 401` as PRESENT. A wrong
 * or missing key is a 401, so it reported every expected table present without having reached the
 * database at all — a guard that passes without touching its subject, which would have made every
 * later live-verification story vacuous.
 */

/** The relation is there. */
export const PRESENT = "PRESENT";
/** The relation is not there — a migration has not been pasted. */
export const ABSENT = "ABSENT";
/** Nothing was established. Never a pass. */
export const UNPROVEN = "UNPROVEN";

/**
 * The nonsense relation every run probes first. Nothing may create it. If a probe for THIS does
 * not read ABSENT, the instrument is not discriminating and no other reading from the same run
 * means anything — see `runCheck`.
 */
export const CONTROL_TABLE = "__tender_absent_probe";
/** The function family's negative control: the same rule, the same consequence. */
export const CONTROL_FUNCTION = "__tender_absent_fn";

/** PostgREST's schema-cache miss, and Postgres's own undefined_table. Both mean absent. */
const ABSENT_CODES = new Set(["PGRST205", "42P01"]);
/**
 * PostgREST's schema-cache miss for a FUNCTION (PGRST202: no function with that name and that
 * set of argument names), and its overload ambiguity (PGRST203: more than one). Neither reached
 * Postgres, and a function the client cannot resolve is absent to the client whatever the
 * catalog holds — resolution is by the set of argument NAMES, so a renamed parameter reads
 * absent here, correctly.
 */
const ABSENT_FUNCTION_CODES = new Set(["PGRST202", "PGRST203"]);
/** A five-character SQLSTATE, as opposed to a PostgREST code (PGRST…) or no code at all. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Postgres's insufficient_privilege. The relation resolved; this role may not read it. */
const REFUSED_CODE = "42501";

/**
 * The error code the answer carries, or null when it carries none.
 *
 * Read from parsed JSON rather than by scanning the raw text, and that is deliberate rather than
 * tidiness. A substring scan would match the same token wherever it appeared — including inside a
 * gateway or proxy message that merely quoted it — which is the failure this module was written to
 * remove. Parsing can only fail toward UNPROVEN, and UNPROVEN is not a pass.
 */
function answerCode(body) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.code === "string") return parsed.code;
  } catch {
    // Not JSON: an HTML page from a proxy, an empty body, a truncated response. No code.
  }
  return null;
}

/**
 * Classify one probe answer.
 *
 * @param {{ status: number, body: string }} answer
 * @returns {{ verdict: string, reason: string, code: string|null, detail: string }}
 */
export function classify({ status, body }) {
  const code = answerCode(body);

  if (status >= 200 && status < 300) {
    return { verdict: PRESENT, reason: "readable", code, detail: "anon can read it" };
  }

  if (code !== null && ABSENT_CODES.has(code)) {
    return { verdict: ABSENT, reason: "missing", code, detail: `not in the schema (${code})` };
  }

  if (code === REFUSED_CODE) {
    return {
      verdict: PRESENT,
      reason: "refused",
      code,
      detail: "anon refused by Postgres (42501) — it exists",
    };
  }

  // A 401 or 403 that carries no SQLSTATE never reached the database. That is the gateway
  // turning the key away, and it proves nothing about any relation.
  if (status === 401 || status === 403) {
    return {
      verdict: UNPROVEN,
      reason: "key-rejected",
      code,
      detail: `the API key was rejected by the gateway (${status}: ${body.slice(0, 120)})`,
    };
  }

  return {
    verdict: UNPROVEN,
    reason: "unrecognised",
    code,
    detail: `${status}: ${body.slice(0, 120)}`,
  };
}

/**
 * Classify one FUNCTION probe answer. The question is again who answered, but the table of
 * answers differs from a table's: any SQLSTATE means Postgres ran the call far enough to raise
 * it, and a call that raises has resolved.
 *
 *   PGRST202 / PGRST203    PostgREST's cache. Never resolved — ABSENT.
 *   25006                  Postgres stopped a write in the read-only transaction. PRESENT, and
 *                          the proof that the probe cannot write.
 *   42501                  Postgres: present, and this role may not execute it (or the body
 *                          raised it itself — accept_answer() says "not signed in"). PRESENT.
 *   any other SQLSTATE     the body ran and raised (P0001, 22P02, …). PRESENT.
 *   2xx                    a function Postgres permits in a read-only transaction ran and
 *                          returned. PRESENT — and it cannot have written.
 *   401/403 with no code   the gateway turned the key away. UNPROVEN.
 *   anything else          UNPROVEN, never a pass.
 *
 * @param {{ status: number, body: string }} answer
 * @returns {{ verdict: string, reason: string, code: string|null, detail: string }}
 */
export function classifyFunction({ status, body }) {
  const code = answerCode(body);

  if (code !== null && ABSENT_FUNCTION_CODES.has(code)) {
    return { verdict: ABSENT, reason: "missing", code, detail: `not in the schema cache (${code})` };
  }

  if (code === "25006") {
    return {
      verdict: PRESENT,
      reason: "write-refused",
      code,
      detail: "ran and was stopped by the read-only transaction (25006) — it exists",
    };
  }

  if (code === REFUSED_CODE) {
    return { verdict: PRESENT, reason: "refused", code, detail: "refused by Postgres (42501) — it exists" };
  }

  if (code !== null && SQLSTATE.test(code)) {
    return { verdict: PRESENT, reason: "raised", code, detail: `ran and raised ${code} — it exists` };
  }

  if (status >= 200 && status < 300) {
    return { verdict: PRESENT, reason: "ran", code, detail: "ran read-only and returned" };
  }

  if (status === 401 || status === 403) {
    return {
      verdict: UNPROVEN,
      reason: "key-rejected",
      code,
      detail: `the API key was rejected by the gateway (${status}: ${body.slice(0, 120)})`,
    };
  }

  return { verdict: UNPROVEN, reason: "unrecognised", code, detail: `${status}: ${body.slice(0, 120)}` };
}

/**
 * Build the read-only probe URL. `limit=0` reads schema and never data, and a GET is served in a
 * read-only transaction whatever the arguments are — so this check cannot write, by construction
 * rather than by care (cairn: postgrest-probing-a-live-project-2026-08-16).
 */
export function probeUrl(baseUrl, table) {
  return `${baseUrl.replace(/\/+$/, "")}/rest/v1/${table}?select=*&limit=0`;
}

/**
 * The GET form of an RPC call. The argument NAMES are the resolution key (see
 * check-live-expected.mjs); the values are placeholders. A function with no arguments is a bare
 * `/rpc/<fn>` — PostgREST answers "without parameters" for an absent one, and resolves a
 * present parameter-free one (measured 2026-08-22).
 */
export function functionProbeUrl(baseUrl, name, args = {}) {
  const qs = new URLSearchParams(args).toString();
  return `${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${name}${qs ? `?${qs}` : ""}`;
}

/**
 * A probe over an injected fetch. This lives here rather than in the runner because a request that
 * never arrives is a VERDICT, not a crash: `fetch` rejects on DNS failure, a refused connection or
 * a dropped socket, and letting that propagate ends the run with a stack trace and exit 1 — the
 * same exit code as a genuinely absent table, which reads as "paste the migration" when the truth
 * is that nothing was asked. A transport failure establishes nothing, so it is UNPROVEN, and the
 * run stops at 2. *Measured 2026-08-22*: before this, an unreachable host exited 1 with an
 * uncaught TypeError.
 */
export function makeProbe({ fetchImpl, baseUrl, key }) {
  return async function probe(table) {
    return get(fetchImpl, key, probeUrl(baseUrl, table));
  };
}

/** The function probe over the same transport: one GET, the same handling of a request that never arrives. */
export function makeFunctionProbe({ fetchImpl, baseUrl, key }) {
  return async function probeFunction(name, args) {
    return get(fetchImpl, key, functionProbeUrl(baseUrl, name, args));
  };
}

async function get(fetchImpl, key, url) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    // status 0 is not an HTTP status. Nothing answered, so the classifier finds no SQLSTATE and
    // no auth status, and reports UNPROVEN.
    return { status: 0, body: `transport failure: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * Decide the whole run.
 *
 * The negative control comes first and is unconditional. A run whose control does not read ABSENT
 * has shown that the instrument cannot distinguish a relation that is there from one that is not —
 * so every other reading it could produce is worthless, and reporting them anyway is exactly the
 * vacuous pass this file exists to refuse. Nothing is reported and the run exits 2.
 *
 * The function family runs after the tables with its own control, for the same reason: a
 * probe that cannot report an absent function ABSENT has proved nothing about a present one.
 * Nothing is probed for a family that was not asked for — `functions` defaults to none, so an
 * older caller's run is unchanged — but an EMPTY list that was passed is refused like an empty
 * table list would be.
 *
 * @param {{ probe: (table: string) => Promise<{status: number, body: string}>,
 *           tables: string[], controlTable?: string,
 *           probeFunction?: (name: string, args: Record<string, string>) => Promise<{status: number, body: string}>,
 *           functions?: { name: string, args: Record<string, string> }[],
 *           controlFunction?: string }} args
 * @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function runCheck({
  probe,
  tables,
  controlTable = CONTROL_TABLE,
  probeFunction,
  functions,
  controlFunction = CONTROL_FUNCTION,
}) {
  const lines = [];

  if (tables.length === 0 || (functions !== undefined && functions.length === 0)) {
    lines.push("check:live: expected set is empty — refusing a vacuous pass");
    return { code: 2, lines };
  }

  const control = classify(await probe(controlTable));
  if (control.verdict !== ABSENT) {
    if (control.reason === "key-rejected") {
      lines.push(`check:live: the API key was rejected — ${control.detail}`);
      lines.push("check:live: nothing reached the database, so no table was probed.");
    } else {
      lines.push(
        `check:live: negative control ${controlTable} read ${control.verdict} (${control.detail})`,
      );
      lines.push(
        "check:live: a probe that cannot report a missing table ABSENT cannot report a present " +
          "one either. No table was probed.",
      );
    }
    return { code: 2, lines };
  }
  lines.push(`ok    ${controlTable}: ABSENT (negative control)`);

  let failures = 0;
  for (const table of tables) {
    const verdict = classify(await probe(table));
    const ok = verdict.verdict === PRESENT;
    if (!ok) failures++;
    lines.push(`${ok ? "ok  " : "FAIL"}  ${table}: ${verdict.verdict} (${verdict.detail})`);
  }
  lines.push(`check:live: ${tables.length - failures}/${tables.length} present`);

  if (functions !== undefined) {
    if (typeof probeFunction !== "function") {
      lines.push("check:live: functions were expected but no function probe was supplied — refusing");
      return { code: 2, lines };
    }
    const fcontrol = classifyFunction(await probeFunction(controlFunction, {}));
    if (fcontrol.verdict !== ABSENT) {
      lines.push(`check:live: negative control ${controlFunction}() read ${fcontrol.verdict} (${fcontrol.detail})`);
      lines.push(
        "check:live: a probe that cannot report a missing function ABSENT cannot report a present " +
          "one either. No function was probed.",
      );
      return { code: 2, lines };
    }
    lines.push(`ok    ${controlFunction}(): ABSENT (negative control)`);

    let ffailures = 0;
    for (const { name, args } of functions) {
      const verdict = classifyFunction(await probeFunction(name, args));
      const ok = verdict.verdict === PRESENT;
      if (!ok) ffailures++;
      lines.push(`${ok ? "ok  " : "FAIL"}  ${name}(${Object.keys(args).join(", ")}): ${verdict.verdict} (${verdict.detail})`);
    }
    lines.push(`check:live: ${functions.length - ffailures}/${functions.length} functions present`);
    failures += ffailures;
  }

  return { code: failures ? 1 : 0, lines };
}
