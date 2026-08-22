/**
 * check:live's classifier and run planner, extracted from the runner so both can be tested
 * against fixture bodies with no live project. `check-live.mjs` supplies the real probe and
 * does nothing else — everything that decides an outcome is here.
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

/** PostgREST's schema-cache miss, and Postgres's own undefined_table. Both mean absent. */
const ABSENT_CODES = new Set(["PGRST205", "42P01"]);
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
 * Build the read-only probe URL. `limit=0` reads schema and never data, and a GET is served in a
 * read-only transaction whatever the arguments are — so this check cannot write, by construction
 * rather than by care (cairn: postgrest-probing-a-live-project-2026-08-16).
 */
export function probeUrl(baseUrl, table) {
  return `${baseUrl.replace(/\/+$/, "")}/rest/v1/${table}?select=*&limit=0`;
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
    try {
      const res = await fetchImpl(probeUrl(baseUrl, table), {
        method: "GET",
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      // status 0 is not an HTTP status. Nothing answered, so `classify` finds no SQLSTATE and no
      // auth status, and reports UNPROVEN.
      return { status: 0, body: `transport failure: ${err instanceof Error ? err.message : err}` };
    }
  };
}

/**
 * Decide the whole run.
 *
 * The negative control comes first and is unconditional. A run whose control does not read ABSENT
 * has shown that the instrument cannot distinguish a relation that is there from one that is not —
 * so every other reading it could produce is worthless, and reporting them anyway is exactly the
 * vacuous pass this file exists to refuse. Nothing is reported and the run exits 2.
 *
 * @param {{ probe: (table: string) => Promise<{status: number, body: string}>,
 *           tables: string[], controlTable?: string }} args
 * @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function runCheck({ probe, tables, controlTable = CONTROL_TABLE }) {
  const lines = [];

  if (tables.length === 0) {
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
  return { code: failures ? 1 : 0, lines };
}
