import { describe, expect, it } from "vitest";
import {
  ABSENT,
  CONTROL_FUNCTION,
  CONTROL_TABLE,
  PRESENT,
  REACHABLE,
  SHUT_OUT,
  UNKNOWN,
  UNPROVEN,
  anonFunctionReach,
  anonTableReach,
  classify,
  classifyFunction,
  functionProbeUrl,
  makeFunctionProbe,
  makeProbe,
  probeUrl,
  runCheck,
} from "../scripts/check-live-core.mjs";

// Fixture bodies, one per party that can answer a probe. The point of the whole module is that
// these are told apart by WHO ANSWERED, so each fixture is labelled with its author.

/** Supabase's API gateway, before Postgres or PostgREST is reached. No SQLSTATE — none exists. */
const GATEWAY_BAD_KEY = JSON.stringify({
  message: "Invalid API key",
  hint: "Double check your Supabase `anon` or `service_role` API key.",
});
/** The same party, when the header is missing rather than wrong. */
const GATEWAY_NO_KEY = JSON.stringify({ message: "No API key found in request" });
/** Postgres. insufficient_privilege — the relation resolved and this role may not read it. */
const PG_REFUSED = JSON.stringify({
  code: "42501",
  details: null,
  hint: null,
  message: "permission denied for table club",
});
/** PostgREST's own schema cache. The relation is not there. */
const PGRST_MISSING = JSON.stringify({
  code: "PGRST205",
  details: null,
  hint: "Perhaps you meant the table 'public.club'",
  message: "Could not find the table 'public.__tender_absent_probe' in the schema cache",
});
/** Postgres's undefined_table — the same answer as PGRST205, from the other side. */
const PG_MISSING = JSON.stringify({
  code: "42P01",
  details: null,
  hint: null,
  message: 'relation "public.__tender_absent_probe" does not exist',
});

describe("the vocabulary itself", () => {
  it("pins the verdict tags and the control table to their literal values", () => {
    // Every assertion below compares a returned tag against an imported one, which would pass
    // whatever the constants said if they were only ever compared with each other. This is the
    // one test that decides what they are.
    expect([PRESENT, ABSENT, UNPROVEN]).toEqual(["PRESENT", "ABSENT", "UNPROVEN"]);
    expect(CONTROL_TABLE).toBe("__tender_absent_probe");
  });

  it("pins the anon-reach tags, which are a different question from the presence tags", () => {
    // Story #48. `UNKNOWN` and `UNPROVEN` are deliberately different words for deliberately
    // different failures: nothing established about a PRIVILEGE, versus nothing established about
    // a RELATION. A run can know a table exists and know nothing about what anon may do with it.
    expect([REACHABLE, SHUT_OUT, UNKNOWN]).toEqual(["REACHABLE", "SHUT-OUT", "UNKNOWN"]);
  });
});

describe("classify — who answered", () => {
  it("reads a rejected key as UNPROVEN, never as present", () => {
    // The defect this module was written to remove: a 401 used to read as PRESENT, so a wrong
    // key reported every expected table present without reaching the database.
    const v = classify({ status: 401, body: GATEWAY_BAD_KEY });
    expect(v.verdict).toBe(UNPROVEN);
    expect(v.reason).toBe("key-rejected");
    expect(v.detail).toMatch(/rejected by the gateway/);
  });

  it("reads a missing key the same way", () => {
    expect(classify({ status: 401, body: GATEWAY_NO_KEY }).reason).toBe("key-rejected");
  });

  it("reads a 403 with no SQLSTATE as a rejected key too", () => {
    expect(classify({ status: 403, body: GATEWAY_BAD_KEY }).reason).toBe("key-rejected");
  });

  it("reads a 401 carrying 42501 as PRESENT — Postgres answered, so the table exists", () => {
    const v = classify({ status: 401, body: PG_REFUSED });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("refused");
    expect(v.code).toBe("42501");
  });

  it("reads a 403 carrying 42501 as PRESENT as well", () => {
    expect(classify({ status: 403, body: PG_REFUSED }).verdict).toBe(PRESENT);
  });

  it("reads PGRST205 as ABSENT", () => {
    const v = classify({ status: 404, body: PGRST_MISSING });
    expect(v.verdict).toBe(ABSENT);
    expect(v.code).toBe("PGRST205");
  });

  it("reads 42P01 as ABSENT — the same answer from the other side", () => {
    expect(classify({ status: 404, body: PG_MISSING }).verdict).toBe(ABSENT);
  });

  it("reads a successful read as PRESENT", () => {
    const v = classify({ status: 200, body: "[]" });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("readable");
  });

  it("reads anything it does not recognise as UNPROVEN", () => {
    // A gateway 500 with an HTML body: no SQLSTATE, not an auth status. Nothing is established.
    const v = classify({ status: 502, body: "<html>Bad Gateway</html>" });
    expect(v.verdict).toBe(UNPROVEN);
    expect(v.reason).toBe("unrecognised");
  });

  it("does not mistake a quoted code in a non-database message for the database answering", () => {
    // The reason the code is read from parsed JSON rather than scanned out of the raw text.
    const v = classify({
      status: 401,
      body: JSON.stringify({ message: "Invalid API key (not a 42501, and not PGRST205)" }),
    });
    expect(v.verdict).toBe(UNPROVEN);
    expect(v.reason).toBe("key-rejected");
  });
});

describe("anonTableReach — what the anon key may DO, story #48", () => {
  it("reads a 200 as REACHABLE — the grant is there, whatever RLS then returned", () => {
    // The whole point of the story: `200 []` is what the caller saw on `club` for two months,
    // and it is what a wide-open table and a properly-shadowed one both look like.
    const r = anonTableReach({ status: 200, body: "[]" });
    expect(r.reach).toBe(REACHABLE);
    expect(r.detail).toMatch(/SELECT/);
  });

  it("reads 42501 as SHUT-OUT — only the refusal proves the grant is gone", () => {
    expect(anonTableReach({ status: 401, body: PG_REFUSED }).reach).toBe(SHUT_OUT);
  });

  it("reads an absent table as UNKNOWN, never as shut out", () => {
    // A table that is not there refuses nobody. Reporting it as SHUT-OUT would let a missing
    // migration read as a closed grant.
    expect(anonTableReach({ status: 404, body: PGRST_MISSING }).reach).toBe(UNKNOWN);
  });

  it("reads a rejected key as UNKNOWN — the gateway never asked Postgres about a privilege", () => {
    expect(anonTableReach({ status: 401, body: GATEWAY_BAD_KEY }).reach).toBe(UNKNOWN);
    expect(anonTableReach({ status: 0, body: "transport failure: fetch failed" }).reach).toBe(UNKNOWN);
  });
});

describe("probeUrl", () => {
  it("reads schema and never data", () => {
    expect(probeUrl("https://x.supabase.co", "club")).toBe(
      "https://x.supabase.co/rest/v1/club?select=*&limit=0",
    );
  });
  it("tolerates a trailing slash on the project URL", () => {
    expect(probeUrl("https://x.supabase.co/", "club")).toMatch("/rest/v1/club?select=*&limit=0");
  });
});

describe("makeProbe", () => {
  it("sends a GET carrying the key, and reads schema not data", async () => {
    let seen: [string, RequestInit] | null = null;
    const probe = makeProbe({
      fetchImpl: async (u: string, init: RequestInit) => {
        seen = [u, init];
        return { status: 401, text: async () => PG_REFUSED };
      },
      baseUrl: "https://x.supabase.co",
      key: "anon-key",
    });
    const answer = await probe("club");
    expect(answer).toEqual({ status: 401, body: PG_REFUSED });
    const [u, init] = seen!;
    expect(u).toBe("https://x.supabase.co/rest/v1/club?select=*&limit=0");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ apikey: "anon-key", Authorization: "Bearer anon-key" });
  });

  it("turns a request that never arrives into an answer, not a crash", async () => {
    // A rejected fetch — DNS failure, refused connection, dropped socket — used to propagate and
    // end the run with a stack trace and exit 1, which is the exit code for a genuinely absent
    // table. Nothing was asked, so nothing is established.
    const probe = makeProbe({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      baseUrl: "https://x.supabase.co",
      key: "anon-key",
    });
    const answer = await probe("club");
    expect(answer.status).toBe(0);
    expect(classify(answer).verdict).toBe(UNPROVEN);
  });

  it("stops the whole run at 2 when the host is unreachable", async () => {
    const probe = makeProbe({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      baseUrl: "https://x.supabase.co",
      key: "anon-key",
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(2); // not 1 — an absent table and an unasked question are different answers
    expect(lines.some((l) => l.includes("club"))).toBe(false);
  });
});

/** A probe stubbed from a table -> answer table. Records what it was asked, in order. */
function stubProbe(answers: Record<string, { status: number; body: string }>) {
  const asked: string[] = [];
  const probe = async (table: string) => {
    asked.push(table);
    const answer = answers[table];
    if (!answer) throw new Error(`test stub has no answer for ${table}`);
    return answer;
  };
  return { probe, asked };
}

describe("runCheck — the negative control", () => {
  it("probes the control first, before any expected table", async () => {
    const { probe, asked } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 401, body: PG_REFUSED },
    });
    const { code } = await runCheck({ probe, tables: ["club"] });
    expect(asked[0]).toBe(CONTROL_TABLE);
    expect(code).toBe(0);
  });

  it("refuses the whole run and reports no table when the control reads PRESENT", async () => {
    // Something creates or shadows the nonsense relation, or the endpoint answers everything
    // affirmatively. Either way the instrument cannot tell present from absent.
    const { probe, asked } = stubProbe({
      [CONTROL_TABLE]: { status: 200, body: "[]" },
      club: { status: 401, body: PG_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(2);
    expect(asked).toEqual([CONTROL_TABLE]); // club was never probed
    expect(lines.join("\n")).toMatch(/negative control/);
    expect(lines.some((l) => l.includes("club"))).toBe(false);
  });

  it("refuses the whole run when the control reads UNPROVEN", async () => {
    const { probe, asked } = stubProbe({
      [CONTROL_TABLE]: { status: 502, body: "<html>Bad Gateway</html>" },
      club: { status: 401, body: PG_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(2);
    expect(asked).toEqual([CONTROL_TABLE]);
    expect(lines.some((l) => l.includes("club"))).toBe(false);
  });

  it("exits 2 saying the key was rejected when the key is bad", async () => {
    const { probe, asked } = stubProbe({
      [CONTROL_TABLE]: { status: 401, body: GATEWAY_BAD_KEY },
      club: { status: 401, body: GATEWAY_BAD_KEY },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(2);
    expect(asked).toEqual([CONTROL_TABLE]);
    // Assert on the line ONLY this branch emits. The generic "control did not read ABSENT"
    // message quotes control.detail, which carries the words "the API key was rejected by the
    // gateway" whatever branch printed it — so matching that phrase passes on both paths and
    // distinguishes nothing. Measured: it stayed green against a mutation that took this branch away.
    expect(lines.join("\n")).toMatch(/nothing reached the database/);
    expect(lines.join("\n")).not.toMatch(/negative control/);
    expect(lines.some((l) => l.includes("club"))).toBe(false);
  });
});

describe("runCheck — reporting", () => {
  it("passes when every expected table is present", async () => {
    const { probe } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 401, body: PG_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/1\/1 present/);
  });

  it("fails when an expected table is absent", async () => {
    const { probe } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 404, body: PGRST_MISSING },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL {2}club: ABSENT/);
  });

  it("fails an expected table whose answer proves nothing", async () => {
    const { probe } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 502, body: "<html>Bad Gateway</html>" },
    });
    const { code } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(1);
  });

  it("refuses an empty expected set without probing anything", async () => {
    const { probe, asked } = stubProbe({});
    const { code, lines } = await runCheck({ probe, tables: [] });
    expect(code).toBe(2);
    expect(asked).toEqual([]);
    expect(lines.join("\n")).toMatch(/vacuous/);
  });
});

// ---------------------------------------------------------------------------------------------
// The function family (story #16 AC 3). A function is probed by calling it over GET, which
// PostgREST serves in a read-only transaction; the answers differ from a table's, so the
// classifier is its own and has its own fixtures — again one per party that can answer.
// ---------------------------------------------------------------------------------------------

/** PostgREST's schema cache: no function with that name and that set of argument names. */
const PGRST_NO_FUNCTION = JSON.stringify({
  code: "PGRST202",
  details: "Searched for the function public.rotate_invite_code without parameters, but no matches were found in the schema cache.",
  hint: null,
  message: "Could not find the function public.rotate_invite_code without parameters in the schema cache",
});
/** PostgREST's schema cache: more than one overload matched. Never reached Postgres either. */
const PGRST_AMBIGUOUS = JSON.stringify({
  code: "PGRST203",
  details: null,
  hint: "Try renaming the parameters or the function itself in the database so function overloading can be resolved",
  message: "Could not choose the best candidate function between: public.f(a => text), public.f(a => uuid)",
});
/** Postgres: the function ran and tried to write inside the read-only transaction. */
const PG_READ_ONLY = JSON.stringify({
  code: "25006",
  details: null,
  hint: null,
  message: "cannot execute UPDATE in a read-only transaction",
});
/** Postgres: execute is not granted to this role — or the body raised 42501 itself. */
const PG_FN_REFUSED = JSON.stringify({
  code: "42501",
  details: null,
  hint: null,
  message: "permission denied for function rotate_invite_code",
});
/** Postgres: the body ran and raised its own error. */
const PG_RAISED = JSON.stringify({ code: "P0001", details: null, hint: null, message: "no household matches that code" });
/**
 * The one that makes `anonFunctionReach` more than a code comparison: `accept_answer` raising
 * `insufficient_privilege` ITSELF, which is `anon` having executed it. Copied verbatim from the
 * live project 2026-08-30 — same code, same status, opposite meaning to PG_FN_REFUSED above.
 */
const PG_FN_OWN_RAISE = JSON.stringify({
  code: "42501",
  details: null,
  hint: null,
  message: "not signed in",
});

describe("classifyFunction — who answered", () => {
  it("reads PGRST202 as ABSENT", () => {
    const v = classifyFunction({ status: 404, body: PGRST_NO_FUNCTION });
    expect(v.verdict).toBe(ABSENT);
    expect(v.code).toBe("PGRST202");
  });

  it("reads PGRST203 as ABSENT — an ambiguous overload is unreachable by the client", () => {
    expect(classifyFunction({ status: 300, body: PGRST_AMBIGUOUS }).verdict).toBe(ABSENT);
  });

  it("classifies 25006 as PRESENT: the function ran and the read-only transaction stopped its write", () => {
    const v = classifyFunction({ status: 405, body: PG_READ_ONLY });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("write-refused");
    expect(v.code).toBe("25006");
  });

  it("classifies 42501 as PRESENT — Postgres answered, so the function exists", () => {
    const v = classifyFunction({ status: 401, body: PG_FN_REFUSED });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("refused");
  });

  it("classifies any other SQLSTATE as PRESENT — the body ran far enough to raise it", () => {
    const v = classifyFunction({ status: 400, body: PG_RAISED });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("raised");
    expect(v.code).toBe("P0001");
  });

  it("classifies a 2xx as PRESENT — a function Postgres let run read-only cannot have written", () => {
    const v = classifyFunction({ status: 200, body: "[]" });
    expect(v.verdict).toBe(PRESENT);
    expect(v.reason).toBe("ran");
  });

  it("reads a rejected key as UNPROVEN, never as present", () => {
    const v = classifyFunction({ status: 401, body: GATEWAY_BAD_KEY });
    expect(v.verdict).toBe(UNPROVEN);
    expect(v.reason).toBe("key-rejected");
  });

  it("does not read a PGRST code it does not know as a SQLSTATE", () => {
    // PGRST100 is a parse error from PostgREST — not Postgres answering. Nothing is established.
    const v = classifyFunction({ status: 400, body: JSON.stringify({ code: "PGRST100", message: "parse error" }) });
    expect(v.verdict).toBe(UNPROVEN);
    expect(v.reason).toBe("unrecognised");
  });

  it("reads a transport failure as UNPROVEN", () => {
    expect(classifyFunction({ status: 0, body: "transport failure: fetch failed" }).verdict).toBe(UNPROVEN);
  });
});

describe("anonFunctionReach — the 42501 that means the opposite, story #48", () => {
  it("reads Postgres's own EXECUTE refusal as SHUT-OUT", () => {
    expect(anonFunctionReach({ status: 401, body: PG_FN_REFUSED }).reach).toBe(SHUT_OUT);
  });

  it("reads the SAME code with the function's own message as REACHABLE", () => {
    // These two fixtures differ in the message and in nothing else — same 42501, same 401 — and
    // they are the difference between anon being shut out and anon running the function. This is
    // the assertion that would fail first if the classifier went back to reading only the code.
    const r = anonFunctionReach({ status: 401, body: PG_FN_OWN_RAISE });
    expect(r.reach).toBe(REACHABLE);
    expect(r.detail).toMatch(/42501/);
  });

  it("reads 25006 as REACHABLE — Postgres only stops a write the body had already started", () => {
    expect(anonFunctionReach({ status: 405, body: PG_READ_ONLY }).reach).toBe(REACHABLE);
  });

  it("reads any other SQLSTATE, and a 2xx, as REACHABLE", () => {
    expect(anonFunctionReach({ status: 400, body: PG_RAISED }).reach).toBe(REACHABLE);
    expect(anonFunctionReach({ status: 200, body: "[]" }).reach).toBe(REACHABLE);
  });

  it("fails loud, not quiet, if Postgres ever changes the wording", () => {
    // The message match is the weak part of the module. It is arranged so that an unrecognised
    // privilege refusal reads as REACHABLE — a false alarm somebody investigates — rather than as
    // SHUT-OUT, which nobody ever looks at again.
    const translated = JSON.stringify({ code: "42501", message: "Zugriff verweigert für Funktion f" });
    expect(anonFunctionReach({ status: 401, body: translated }).reach).toBe(REACHABLE);
  });

  it("reads an absent function and a rejected key as UNKNOWN", () => {
    expect(anonFunctionReach({ status: 404, body: PGRST_NO_FUNCTION }).reach).toBe(UNKNOWN);
    expect(anonFunctionReach({ status: 401, body: GATEWAY_BAD_KEY }).reach).toBe(UNKNOWN);
  });
});

describe("functionProbeUrl", () => {
  it("is a bare /rpc/<fn> for a parameter-free function", () => {
    expect(functionProbeUrl("https://x.supabase.co", "rotate_invite_code", {})).toBe(
      "https://x.supabase.co/rest/v1/rpc/rotate_invite_code",
    );
  });
  it("carries the argument names the client sends, as a query string", () => {
    expect(functionProbeUrl("https://x.supabase.co/", "accept_answer", { post_id: "a", person_id: "b" })).toBe(
      "https://x.supabase.co/rest/v1/rpc/accept_answer?post_id=a&person_id=b",
    );
  });
});

describe("makeFunctionProbe", () => {
  it("sends a GET — never a POST — carrying the key, to the rpc path", async () => {
    let seen: [string, RequestInit] | null = null;
    const probe = makeFunctionProbe({
      fetchImpl: async (u: string, init: RequestInit) => {
        seen = [u, init];
        return { status: 405, text: async () => PG_READ_ONLY };
      },
      baseUrl: "https://x.supabase.co",
      key: "anon-key",
    });
    const answer = await probe("rotate_invite_code", {});
    expect(answer).toEqual({ status: 405, body: PG_READ_ONLY });
    const [u, init] = seen!;
    expect(u).toBe("https://x.supabase.co/rest/v1/rpc/rotate_invite_code");
    expect(init.method).toBe("GET"); // the whole safety argument: a POST would run the write
    expect(init.headers).toEqual({ apikey: "anon-key", Authorization: "Bearer anon-key" });
  });

  it("turns a request that never arrives into UNPROVEN, not a crash", async () => {
    const probe = makeFunctionProbe({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      baseUrl: "https://x.supabase.co",
      key: "anon-key",
    });
    expect(classifyFunction(await probe("rotate_invite_code", {})).verdict).toBe(UNPROVEN);
  });
});

/** A function probe stubbed from a name -> answer table. Records what it was asked, in order. */
function stubFunctionProbe(answers: Record<string, { status: number; body: string }>) {
  const asked: string[] = [];
  const probeFunction = async (name: string, args: Record<string, string>) => {
    asked.push(`${name}(${Object.keys(args).join(",")})`);
    const answer = answers[name];
    if (!answer) throw new Error(`test stub has no answer for ${name}`);
    return answer;
  };
  return { probeFunction, asked };
}

const TABLES_OK = { [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING }, club: { status: 401, body: PG_REFUSED } };
const ROTATE = { name: "rotate_invite_code", args: {} };
const ACCEPT = { name: "accept_answer", args: { post_id: "0", person_id: "0" } };

describe("runCheck — the function family", () => {
  it("probes the function control first, then each function with its argument names, and passes", async () => {
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction, asked } = stubFunctionProbe({
      [CONTROL_FUNCTION]: { status: 404, body: PGRST_NO_FUNCTION },
      // Both shut out. Since #48 a healthy run cannot contain a 25006 here: that answer means
      // anon executed the function, which is a finding rather than a pass — see the reach tests.
      rotate_invite_code: { status: 401, body: PG_FN_REFUSED },
      accept_answer: { status: 401, body: PG_FN_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [ROTATE, ACCEPT] });
    expect(asked).toEqual([`${CONTROL_FUNCTION}()`, "rotate_invite_code()", "accept_answer(post_id,person_id)"]);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/ok {4}__tender_absent_fn\(\): ABSENT/);
    expect(lines.join("\n")).toMatch(/ok {4}rotate_invite_code\(\): PRESENT \(refused by Postgres/);
    expect(lines.join("\n")).toMatch(/2\/2 functions present/);
  });

  it("fails the run when a function is absent, and says which", async () => {
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction } = stubFunctionProbe({
      [CONTROL_FUNCTION]: { status: 404, body: PGRST_NO_FUNCTION },
      rotate_invite_code: { status: 404, body: PGRST_NO_FUNCTION },
      accept_answer: { status: 401, body: PG_FN_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [ROTATE, ACCEPT] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL {2}rotate_invite_code\(\): ABSENT/);
    expect(lines.join("\n")).toMatch(/1\/2 functions present/);
  });

  it("refuses the function half and probes no function when the function control does not read ABSENT", async () => {
    // The table control is fine and the tables pass; the function family's own instrument is
    // broken — an endpoint answering every rpc affirmatively. Nothing about functions is reported.
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction, asked } = stubFunctionProbe({
      [CONTROL_FUNCTION]: { status: 200, body: "[]" },
      rotate_invite_code: { status: 405, body: PG_READ_ONLY },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [ROTATE] });
    expect(code).toBe(2);
    expect(asked).toEqual([`${CONTROL_FUNCTION}()`]);
    expect(lines.join("\n")).toMatch(/negative control __tender_absent_fn\(\) read PRESENT/);
    expect(lines.some((l) => l.includes("rotate_invite_code"))).toBe(false);
  });

  it("does not probe functions at all when none were asked for, and the table run is unchanged", async () => {
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction, asked } = stubFunctionProbe({});
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction });
    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(lines.some((l) => l.includes("functions"))).toBe(false);
  });

  it("refuses an empty function list as vacuous, like an empty table list", async () => {
    const { probe, asked } = stubProbe(TABLES_OK);
    const { probeFunction } = stubFunctionProbe({});
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [] });
    expect(code).toBe(2);
    expect(asked).toEqual([]);
    expect(lines.join("\n")).toMatch(/vacuous/);
  });

  it("refuses when functions are expected but no probe was supplied", async () => {
    const { probe } = stubProbe(TABLES_OK);
    const { code, lines } = await runCheck({ probe, tables: ["club"], functions: [ROTATE] });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/no function probe/);
  });
});

// ---------------------------------------------------------------------------------------------
// The anon-reach verdict (story #48). These are the ONLY positive controls this half of the
// module will ever get: once 0015 is pasted, nothing on the live project is REACHABLE, so the
// branch that finds a hole runs on no healthy day and against no real project
// (cairn: satisfying-a-negative-claim-destroys-its-instrument-2026-08-26).
// ---------------------------------------------------------------------------------------------

describe("runCheck — anon reach", () => {
  it("reports a count over everything it probed, and passes when nothing is reachable", async () => {
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction } = stubFunctionProbe({
      [CONTROL_FUNCTION]: { status: 404, body: PGRST_NO_FUNCTION },
      rotate_invite_code: { status: 401, body: PG_FN_REFUSED },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [ROTATE] });
    expect(code).toBe(0);
    // "0 of 2", not "0" — a bare none is what a run that probed nothing would also say.
    expect(lines.join("\n")).toMatch(/anon reach — 0 of 2 probed subjects still reachable/);
    expect(lines.some((l) => l.startsWith("FAIL  anon reach"))).toBe(false);
  });

  it("fails the run on a table anon can read, and names it — though it is PRESENT either way", async () => {
    // The pre-0015 live project, exactly: `club` answering 200 [] while every other table
    // answered 42501. Before this, that run exited 0 and said "14/14 present".
    const { probe } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 200, body: "[]" },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/ok {4}club: PRESENT .* \| anon REACHABLE/);
    expect(lines.join("\n")).toMatch(/FAIL {2}anon reach: table club/);
    expect(lines.join("\n")).toMatch(/anon reach — 1 of 1 probed subjects still reachable/);
    expect(lines.join("\n")).toMatch(/0015 has not been pasted/);
  });

  it("fails the run on a function anon can execute, and names it", async () => {
    // `answer_counts` answering 200 [] to the anon key, and `accept_answer` raising its own
    // 42501 — the two live readings 0015 was written for, in one run.
    const { probe } = stubProbe(TABLES_OK);
    const { probeFunction } = stubFunctionProbe({
      [CONTROL_FUNCTION]: { status: 404, body: PGRST_NO_FUNCTION },
      rotate_invite_code: { status: 200, body: "[]" },
      accept_answer: { status: 401, body: PG_FN_OWN_RAISE },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"], probeFunction, functions: [ROTATE, ACCEPT] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/2\/2 functions present/); // both exist — that is not the finding
    expect(lines.join("\n")).toMatch(/FAIL {2}anon reach: function rotate_invite_code\(\)/);
    expect(lines.join("\n")).toMatch(/FAIL {2}anon reach: function accept_answer\(\)/);
    expect(lines.join("\n")).toMatch(/anon reach — 2 of 3 probed subjects still reachable/);
  });

  it("does not count an absent relation as shut out", async () => {
    // An ABSENT table already fails the run on presence. What it must not do is quietly improve
    // the reach reading: a missing migration is not a closed grant.
    const { probe } = stubProbe({
      [CONTROL_TABLE]: { status: 404, body: PGRST_MISSING },
      club: { status: 404, body: PGRST_MISSING },
    });
    const { code, lines } = await runCheck({ probe, tables: ["club"] });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/anon reach — 0 of 1 probed subjects still reachable/);
    expect(lines.some((l) => l.startsWith("FAIL  anon reach"))).toBe(false);
    expect(lines.join("\n")).toMatch(/FAIL {2}club: ABSENT/);
  });
});
