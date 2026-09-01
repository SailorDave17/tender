import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { echoQuery, localBytes, localChars, localDigest } from "../scripts/management-api.mjs";
import {
  KNOWN_FLAGS,
  MIGRATIONS_DIR,
  applyMigration,
  assertKnownFlags,
  dryRunRequested,
  main,
  migrationFileFrom,
  planLines,
} from "../scripts/migrate-live.mjs";

/**
 * `npm run migrate:live` (#114), tested with no network, no credential and no live project.
 *
 * Everything below is a decision the command makes before or instead of touching the wire. The
 * one thing not tested here is the real `fetch`, which is the one thing a test cannot supply.
 */

const ROOT = process.cwd();
const GOOD_URL = "https://iszdmtinhgnjwtnyetdn.supabase.co";
const REAL_MIGRATION = `${MIGRATIONS_DIR}/0015_anon_revoke.sql`;

/**
 * A `.env.local` that is not there.
 *
 * Every `main` call below passes this. Without it these tests read the developer's REAL
 * `.env.local`, so "a run with no token is refused" would quietly become "a run with the owner's
 * token is refused" — and then stop refusing — the day a token is added. A test whose verdict
 * depends on the machine's credential state is not a test of this code.
 */
const NO_ENV_FILE = () => {
  throw new Error("ENOENT: no .env.local in this test");
};

describe("a rehearsal is honoured whichever way it is spelled (AC 5)", () => {
  it("`-- --dry-run`, which arrives in argv", () => {
    expect(dryRunRequested(["f.sql", "--dry-run"], {})).toBe(true);
  });

  it("`--dry-run`, which npm EATS and reports in the environment instead", () => {
    // The trap this exists for: `npm run` has a `--dry-run` of its own and claims it first, so
    // the natural spelling — the one a person types — reaches the script with NO flag in argv and
    // would perform a real, irreversible apply while the operator believed they had rehearsed.
    expect(dryRunRequested(["f.sql"], { npm_config_dry_run: "true" })).toBe(true);
    expect(dryRunRequested(["f.sql"], { npm_config_dry_run: "1" })).toBe(true);
  });

  it("neither channel carrying it means a real run", () => {
    expect(dryRunRequested(["f.sql"], {})).toBe(false);
    expect(dryRunRequested(["f.sql"], { npm_config_dry_run: "false" })).toBe(false);
    expect(dryRunRequested(["f.sql"], { npm_config_dry_run: "" })).toBe(false);
  });
});

describe("an unknown flag is REFUSED rather than dropped (AC 5)", () => {
  it("the near-misses of the one flag that stops the apply", () => {
    // Each of these would otherwise be filtered out as a `-`-prefixed non-file and the run would
    // apply for real. The person who typed them is by definition expecting nothing to happen.
    for (const typo of ["--dry-rnu", "--dryrun", "--pretend", "-n"]) {
      expect(() => assertKnownFlags(["f.sql", typo])).toThrow(/Unknown flag/);
    }
  });

  it("the refusal shows BOTH working spellings, since one of them is npm's fault", () => {
    // `expect.assertions` is load-bearing here rather than decoration. Written as a bare
    // try/catch, this test passes VACUOUSLY the moment `assertKnownFlags` stops throwing — the
    // catch is never entered, no assertion runs, and green means nothing (cairn:
    // prove-a-guard-test-can-fail, the eighth outcome). Declaring the count makes a no-op
    // mutation of the guard redden this test instead of sailing through it.
    expect.assertions(3);
    try {
      assertKnownFlags(["f.sql", "--dryrun"]);
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain("Unknown flag: --dryrun");
      expect(message).toContain("-- --dry-run");
      expect(message).toContain("Nothing was sent and nothing was changed.");
    }
  });

  it("the flag it does know is allowed through, and a bare file needs no flag", () => {
    expect(assertKnownFlags(["f.sql", "--dry-run"])).toEqual(["f.sql", "--dry-run"]);
    expect(assertKnownFlags(["f.sql"])).toEqual(["f.sql"]);
    expect(KNOWN_FLAGS).toEqual(["--dry-run"]);
  });
});

describe("the file must be a migration, and the check cannot be talked around (AC 4)", () => {
  it("names the real migration's absolute path", () => {
    expect(migrationFileFrom([REAL_MIGRATION], ROOT)).toBe(resolve(ROOT, REAL_MIGRATION));
  });

  it("no argument is refused, and says this takes a FILE and never SQL", () => {
    expect(() => migrationFileFrom([], ROOT)).toThrow(/Name the migration/);
    expect(() => migrationFileFrom(["--dry-run"], ROOT)).toThrow(/Name the migration/);
    expect(() => migrationFileFrom([], ROOT)).toThrow(/takes a FILE, never SQL/);
  });

  it("two files are refused, because applying both would hide which one failed", () => {
    expect(() => migrationFileFrom([REAL_MIGRATION, REAL_MIGRATION], ROOT)).toThrow(/One file at a time/);
  });

  it("a path OUTSIDE the migrations directory is refused", () => {
    expect(() => migrationFileFrom(["package.json"], ROOT)).toThrow(/Not a migration/);
    expect(() => migrationFileFrom(["src/app/page.tsx"], ROOT)).toThrow(/Not a migration/);
  });

  it("the check is on the RESOLVED path, so `..` cannot escape it", () => {
    // A comparison against the text would pass this, and the whole value of the restriction is
    // that it cannot be talked around.
    expect(() => migrationFileFrom([`${MIGRATIONS_DIR}/../../secrets.sql`], ROOT)).toThrow(/Not a migration/);
    expect(() => migrationFileFrom([`${MIGRATIONS_DIR}/../.env.local`], ROOT)).toThrow(/Not a migration/);
  });

  it("a nested file under the directory is refused too — it is one flat directory", () => {
    expect(() => migrationFileFrom([`${MIGRATIONS_DIR}/sub/0001.sql`], ROOT)).toThrow(/Not a migration/);
  });

  it("a non-.sql file inside the directory is refused", () => {
    expect(() => migrationFileFrom([`${MIGRATIONS_DIR}/README.md`], ROOT)).toThrow(/Not a .sql file/);
  });
});

describe("the plan describes the file before anything is sent (AC 6)", () => {
  const sql = readFileSync(resolve(ROOT, REAL_MIGRATION), "utf8");

  it("names the project, the file, the statement count and both sizes", () => {
    const lines = planLines({ ref: "iszdmtinhgnjwtnyetdn", path: REAL_MIGRATION, sql });
    expect(lines.join("\n")).toContain("iszdmtinhgnjwtnyetdn");
    expect(lines.join("\n")).toContain(REAL_MIGRATION);
    expect(lines.join("\n")).toContain(`characters : ${localChars(sql)}`);
    expect(lines.join("\n")).toContain(`bytes: ${localBytes(sql)}`);
    expect(lines.join("\n")).toContain(localDigest(sql));
  });

  it("0015 carries non-ASCII, which is what the echo check is FOR", () => {
    // If these were equal the whole cp1252 hazard would be unreachable for this file and the
    // assertion above would prove less than it looks like it does.
    expect(localBytes(sql)).toBeGreaterThan(localChars(sql));
  });
});

describe("a dry run sends nothing and needs no credential (AC 6)", () => {
  it("prints the plan, says nothing was sent, and never asks for a token", async () => {
    // The token is required AFTER the plan and BEFORE anything is sent, which is what makes a dry
    // run useful to somebody deciding whether to hold one. The environment here has NO token, so
    // this would refuse if the order were wrong.
    const lines: string[] = [];
    const result = await main([REAL_MIGRATION, "--dry-run"], { NEXT_PUBLIC_SUPABASE_URL: GOOD_URL }, {
      log: (line: string) => void lines.push(line),
    } as unknown as Console, NO_ENV_FILE);
    expect(result).toEqual({ dryRun: true });
    expect(lines.join("\n")).toContain("--dry-run: nothing was sent and nothing was applied.");
    expect(lines.join("\n")).toContain("iszdmtinhgnjwtnyetdn");
  });

  it("a real run with no token refuses BY NAME, having printed the same plan", async () => {
    const lines: string[] = [];
    await expect(
      main([REAL_MIGRATION], { NEXT_PUBLIC_SUPABASE_URL: GOOD_URL }, {
        log: (line: string) => void lines.push(line),
      } as unknown as Console, NO_ENV_FILE),
    ).rejects.toThrow(/SUPABASE_ACCESS_TOKEN is not set/);
    expect(lines.join("\n")).toContain("statements :");
  });

  it("an unreadable project URL refuses before the file is even looked at", async () => {
    await expect(
      main([REAL_MIGRATION], { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, {
        log: () => {},
      } as unknown as Console, NO_ENV_FILE),
    ).rejects.toThrow(/Cannot work out which project/);
  });
});

describe("the echo comes first, and a mangled payload is never applied (AC 7)", () => {
  const sql = "select 1;";
  const intact = {
    chars: localChars(sql),
    bytes: localBytes(sql),
    digest: localDigest(sql),
  };

  /** A fake wire that answers the echo with `echo`, then the apply with `apply`. */
  const wire = (echo: unknown, apply: unknown = []) => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).query);
      const payload = bodies.length === 1 ? echo : apply;
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  };

  it("the echo asks for a READ-ONLY transaction and the apply asks for a writable one", async () => {
    // Each stage states its own intent rather than inheriting a vendor default. The echo's claim
    // is that it inspects without applying, and until this flag existed that rested entirely on
    // `echoQuery` producing a SELECT — a property a later edit could lose with nothing to say so.
    //
    // What this does NOT prove, and the code says so too: on a credential that connects as
    // `supabase_read_only_user` the flag changes nothing in either direction. Sending it is
    // correctness, not a capability.
    const flags: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      flags.push(body.read_only);
      return { ok: true, status: 200, text: async () => JSON.stringify(flags.length === 1 ? [intact] : []) };
    }) as unknown as typeof fetch;
    await applyMigration({ ref: "r", token: "t", sql, fetchImpl });
    expect(flags).toEqual([true, false]);
  });

  it("an intact payload is applied, and the apply carries the RAW sql", async () => {
    const { fetchImpl, bodies } = wire([intact]);
    const result = await applyMigration({ ref: "r", token: "t", sql, fetchImpl });
    expect(result).toMatchObject({ ok: true, stage: "apply", applied: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(echoQuery(sql));
    expect(bodies[1]).toBe(sql);
  });

  it("a MISMATCH stops the run with NOTHING applied — one request, not two", async () => {
    // The assertion that matters is the call count. A version that compared and then applied
    // anyway would satisfy every other expectation here.
    const { fetchImpl, bodies } = wire([{ ...intact, digest: "0".repeat(32) }]);
    const result = await applyMigration({ ref: "r", token: "t", sql, fetchImpl });
    expect(result.applied).toBe(false);
    expect(result.stage).toBe("echo");
    expect(result.problems?.join(" ")).toMatch(/md5 differs/);
    expect(bodies).toHaveLength(1);
  });

  it("an echo that returns no rows is a mismatch, not a pass", async () => {
    const { fetchImpl, bodies } = wire([]);
    const result = await applyMigration({ ref: "r", token: "t", sql, fetchImpl });
    expect(result.applied).toBe(false);
    expect(result.problems).toEqual(["the database returned no description of what it received"]);
    expect(bodies).toHaveLength(1);
  });

  it("an echo that never arrives stops the run, and says so as a transport failure", async () => {
    const result = await applyMigration({
      ref: "r",
      token: "t",
      sql,
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, stage: "echo", applied: false });
    expect(result.problems).toBeUndefined();
    expect(result.error).toMatch(/never completed/);
  });

  it("SQL Postgres refuses is reported as the FILE's fault, not the wire's", async () => {
    // Without this distinction a migration whose SQL is simply wrong reads as a transport
    // problem, and somebody goes looking at the network instead of at the file.
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1
        ? { ok: true, status: 200, text: async () => JSON.stringify([intact]) }
        : { ok: false, status: 400, text: async () => JSON.stringify({ message: 'relation "nope" does not exist' }) };
    }) as unknown as typeof fetch;
    const result = await applyMigration({ ref: "r", token: "t", sql, fetchImpl });
    expect(result).toMatchObject({ ok: false, stage: "apply", applied: false });
    expect(result.error).toMatch(/relation "nope" does not exist/);
    expect(result.received).toEqual(intact);
  });
});
