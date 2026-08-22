import { describe, expect, it } from "vitest";
import {
  ABSENT,
  CONTROL_TABLE,
  PRESENT,
  UNPROVEN,
  classify,
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
