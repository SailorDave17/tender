import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * The ladder clock's two schedulers (story #26): `0017_ladder_tick_schedule.sql` for pg_cron every
 * fifteen minutes, and `vercel.json` for Vercel's daily sweep.
 *
 * NEITHER IS OBSERVABLE FROM ANY INSTRUMENT THIS REPO ALREADY HAS. `check:live` reads tables and
 * functions over PostgREST and this migration creates neither; `verify:migrations` reads
 * `pg_catalog` for state the FILES describe, and a guarded `do` block describes a state only
 * conditionally; `vercel.json` is read by Vercel and by nothing in the build. So this file is the
 * only automated hold on either, and #27 owns the live half — the job listed in `cron.job`, and a
 * SUCCEEDED row in `cron.job_run_details`.
 *
 * ONE DATABASE, DELIBERATELY, AND THE ORDER OF THESE DESCRIBES IS LOAD-BEARING. Everything here
 * runs against a bare PGlite with no migrations at all — `0017` reads `pg_extension` and nothing
 * this schema owns — and a `do` block that raises rolls itself back, so the mutants and the real
 * file share one boot. The no-op cases must run BEFORE the stubs below are created, because the
 * stubs are exactly the schemas those cases assert are absent. A second boot would cost the run
 * about as much again as everything this file asserts (`test/pglite.ts` records 1401–9140 ms of
 * every call as the WASM boot), and booting two in parallel has already pushed
 * `harness-budget.test.ts` past its budget once (#24).
 */

const MIGRATION = "0017_ladder_tick_schedule.sql";
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

let db: PGlite;
let sql: string;

beforeAll(async () => {
  sql = await readFile(join(MIGRATIONS, MIGRATION), "utf8");
  db = new PGlite();
  await db.exec("select 1"); // the boot happens inside the first exec, not the constructor
});

afterAll(async () => {
  await db.close();
});

/** Replace exactly once, or throw — a bare `replace` that matched nothing is a silent no-op. */
function mutate(text: string, pattern: RegExp, replacement: string): string {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const hits = text.match(global);
  if (hits?.length !== 1) {
    throw new Error(`mutation pattern matched ${hits?.length ?? 0} times, expected exactly 1: ${pattern}`);
  }
  return text.replace(pattern, replacement);
}

/** The `if not exists (… pg_cron …) then return; end if;` prelude — AC 1's conditional guard. */
const PG_CRON_GUARD = /if not exists \(select 1 from pg_extension where extname = 'pg_cron'\) then\s*return;\s*end if;/;

/** The job name, the cron expression and the command, read out of the file rather than restated. */
function scheduleCall(text: string): { job: string; schedule: string; command: string } {
  const m = /perform cron\.schedule\(\s*'([a-z-]+)',\s*'([^']*)',\s*\$cmd\$([\s\S]*?)\$cmd\$\s*\)/.exec(text);
  if (!m) throw new Error("no cron.schedule(name, schedule, $cmd$…$cmd$) call found in the migration");
  return { job: m[1], schedule: m[2], command: m[3] };
}

// -------------------------------------------------------------------------------------------
// 1. The file is a clean no-op wherever pg_cron is absent — AC 1, and AC 5's claim as a control
// -------------------------------------------------------------------------------------------

describe("0017 — a clean no-op wherever pg_cron is absent", () => {
  it("this Postgres really has none of the three extensions the file is about", async () => {
    // The precondition every case below rests on. Without it "it applied silently" would be
    // consistent with the guard never being reached, and the no-op claim would be vacuous.
    const r = await db.query<{ extname: string }>(
      `select extname from pg_extension where extname in ('pg_cron', 'pg_net', 'supabase_vault')`,
    );
    expect(r.rows).toEqual([]);
    const schemas = await db.query<{ nspname: string }>(
      `select nspname from pg_namespace where nspname in ('cron', 'net', 'vault')`,
    );
    expect(schemas.rows).toEqual([]);
  });

  it("applies, and leaves nothing behind (AC 1)", async () => {
    await db.exec(sql);
    // A no-op means no-op: no schema, no relation, no function. Asserting only that the apply did
    // not throw would pass on a file that quietly created something.
    const after = await db.query<{ n: number }>(
      `select (select count(*) from pg_namespace where nspname in ('cron', 'net', 'vault'))
            + (select count(*) from pg_class where relnamespace = 'public'::regnamespace)
            + (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as n`,
    );
    expect(Number(after.rows[0].n)).toBe(0);
  });

  it("applies a second time (re-pasting replaces the schedule, it does not add a job)", async () => {
    await expect(db.exec(sql)).resolves.toBeDefined();
  });

  /**
   * AC 5's claim, as a control rather than as a hand mutation: the guard is what makes the file
   * safe here, so with it gone the file must FAIL to apply.
   *
   * Two mutants, because they fail for different reasons and only the second reaches the reason
   * the guard exists. Removing the pg_cron return alone lands on the pg_net refusal — which is
   * this story's own measured finding, since pg_net is not installed on the live project either —
   * while removing all three guards reaches `cron.schedule` and dies on the missing schema.
   *
   * Written as a control and not left to the hand pass because a mutation nobody re-runs proves
   * the guard was load-bearing on one afternoon. This one re-runs on every push.
   */
  it("without the pg_cron guard it refuses at the pg_net check (control)", async () => {
    const mutant = mutate(sql, PG_CRON_GUARD, "");
    await expect(db.exec(mutant)).rejects.toThrow(/pg_net/);
  });

  it("without any guard it reaches cron.schedule and fails on the missing schema (control)", async () => {
    let mutant = mutate(sql, PG_CRON_GUARD, "");
    mutant = mutate(mutant, /if not exists \(select 1 from pg_extension where extname = 'pg_net'\) then[\s\S]*?end if;/, "");
    mutant = mutate(
      mutant,
      /if not exists \(select 1 from pg_extension where extname = 'supabase_vault'\) then[\s\S]*?end if;/,
      "",
    );
    await expect(db.exec(mutant)).rejects.toThrow(/cron/i);
  });

  it("the database is still clean after both refusals", async () => {
    // A raise inside a `do` block rolls the whole statement back, which is what lets the mutants
    // above share this boot. If that stopped being true they would be reporting about a database
    // the earlier cases had already changed.
    const after = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_namespace where nspname in ('cron', 'net', 'vault')`,
    );
    expect(after.rows[0].n).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// 2. The scheduled command itself — the half nothing else in the repo can reach
// -------------------------------------------------------------------------------------------

/**
 * pg_cron stores its command as TEXT and runs it every fifteen minutes on a server this suite
 * never sees, so without what follows the entire body of the migration is a string nobody
 * executes: the Vault lookups, the refusal when a secret is missing, and the shape of the request
 * would all be unheld, and a typo in any of them would surface as a clock that quietly never runs.
 *
 * So the command is EXTRACTED from the file — not restated here — and run against stand-ins for
 * the two extensions. The stubs are the smallest thing that makes the command's own decisions
 * observable: `vault.decrypted_secrets` with the two columns it reads, and a `net.http_post` that
 * records its arguments instead of making a request. Same device as `test/pglite.ts`'s `auth.users`
 * and `auth.uid()`, and the same stated limit: it proves what the command DOES, never that pg_net
 * or Vault behave as assumed. #27 is where the real ones answer.
 */
describe("the scheduled command reads Vault and posts the tick", () => {
  const URL_SECRET = "https://example.invalid/api/ladder/tick";
  const BEARER_SECRET = "not-a-real-secret-0123456789";

  beforeAll(async () => {
    await db.exec(`
      create schema vault;
      -- The real thing is a view over the encrypted table; what the command depends on is the two
      -- column names and that a missing secret yields no row.
      create table vault.decrypted_secrets (name text primary key, decrypted_secret text not null);

      create schema net;
      create table net.calls (id bigserial primary key, url text, headers jsonb);
      -- Named arguments, because the command calls it with url := / headers := and a stub with the
      -- wrong parameter names would fail to resolve — which is itself worth catching.
      create function net.http_post(url text, headers jsonb default '{}'::jsonb) returns bigint
        language sql as $stub$
          insert into net.calls (url, headers) values (url, headers) returning id;
        $stub$;
    `);
  });

  async function setSecrets(names: Record<string, string>) {
    await db.exec("delete from vault.decrypted_secrets;");
    for (const [name, value] of Object.entries(names)) {
      await db.query("insert into vault.decrypted_secrets (name, decrypted_secret) values ($1, $2)", [name, value]);
    }
  }

  const callCount = async () =>
    Number((await db.query<{ n: number }>("select count(*)::int as n from net.calls")).rows[0].n);

  it("is scheduled as ladder-tick, every fifteen minutes", () => {
    // The interval is the story's own number and lives nowhere else — nothing in the app or the
    // catalog can report it, so this assertion is the only thing that moves when it changes.
    const { job, schedule } = scheduleCall(sql);
    expect(job).toBe("ladder-tick");
    expect(schedule).toBe("*/15 * * * *");
  });

  it("posts to the Vault URL with the Vault secret as a bearer token", async () => {
    await setSecrets({ ladder_tick_url: URL_SECRET, ladder_tick_secret: BEARER_SECRET });
    await db.exec(scheduleCall(sql).command);

    const call = await db.query<{ url: string; auth: string; type: string }>(
      `select url, headers ->> 'Authorization' as auth, headers ->> 'Content-Type' as type
         from net.calls order by id desc limit 1`,
    );
    expect(await callCount()).toBe(1);
    expect(call.rows[0].url).toBe(URL_SECRET);
    expect(call.rows[0].auth).toBe(`Bearer ${BEARER_SECRET}`);
    expect(call.rows[0].type).toBe("application/json");
  });

  /**
   * The refusal is the reason the command is a `do` block rather than a one-line `select`. Without
   * it, `'Bearer ' || null` is NULL, the request goes out with no credential, the route answers
   * 401, and pg_cron records the run as SUCCEEDED — because posting was all pg_net was asked to
   * do. Both directions are asserted: it raises, AND no request is made.
   */
  it("raises and posts nothing when the secret is missing", async () => {
    await setSecrets({ ladder_tick_url: URL_SECRET });
    const before = await callCount();
    await expect(db.exec(scheduleCall(sql).command)).rejects.toThrow(/ladder_tick_secret/);
    expect(await callCount()).toBe(before);
  });

  it("raises and posts nothing when the URL is missing", async () => {
    await setSecrets({ ladder_tick_secret: BEARER_SECRET });
    const before = await callCount();
    await expect(db.exec(scheduleCall(sql).command)).rejects.toThrow(/ladder_tick_url/);
    expect(await callCount()).toBe(before);
  });

  it("raises and posts nothing when Vault holds neither", async () => {
    await setSecrets({});
    const before = await callCount();
    await expect(db.exec(scheduleCall(sql).command)).rejects.toThrow(/ladder_tick_url/);
    expect(await callCount()).toBe(before);
  });
});

// -------------------------------------------------------------------------------------------
// 3. Nothing secret is committed — AC 2
// -------------------------------------------------------------------------------------------

describe("no credential and no project URL is committed (AC 2)", () => {
  /**
   * The story's own criterion, kept as a guard rather than as a check somebody ran once. It scans
   * `supabase/` — this file lives in `test/`, so the patterns below are not their own subject
   * (cairn: a-guard-that-reads-source-must-survive-its-own-docs-2026-08-09).
   */
  const patterns = [/Bearer [A-Za-z0-9]/, /https:\/\/[a-z0-9-]+\.supabase\.co/];

  it("no migration carries a bearer token or a project URL", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(join(MIGRATIONS, file), "utf8");
      text.split("\n").forEach((line, i) => {
        if (patterns.some((p) => p.test(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the scan can see both shapes when they are present (positive control)", () => {
    // Assembled from fragments so the literals are not themselves matchable text in this file, and
    // so a later reader cannot simplify them into something that stops being a control.
    const token = ["Bea", "rer ", "sbp1234"].join("");
    const url = ["https://", "abcdefghij", ".supabase", ".co"].join("");
    expect(patterns.some((p) => p.test(token))).toBe(true);
    expect(patterns.some((p) => p.test(url))).toBe(true);
    expect(patterns.some((p) => p.test("select 1 from pg_extension"))).toBe(false);
  });

  it("the two Vault secret names the migration reads are the two the runbook names (AC 4)", async () => {
    // DERIVED from the migration rather than listed here: the names are read back out of the
    // `vault.decrypted_secrets` lookups, so renaming one in the SQL and not in the README is what
    // goes red. A pair of literals in this file would agree with itself and with nothing else.
    const names = [...sql.matchAll(/vault\.decrypted_secrets where name = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(["ladder_tick_secret", "ladder_tick_url"]);

    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    for (const name of names) expect(readme, `README.md does not name ${name}`).toContain(name);
    // and both halves of the confirmation the criterion asks the owner to run: a listed job is the
    // reassuring half, a succeeded run is the load-bearing one
    expect(readme).toContain("from cron.job;");
    expect(readme).toContain("cron.job_run_details");
    expect(readme).toContain("CRON_SECRET");
  });
});

// -------------------------------------------------------------------------------------------
// 4. The second, daily clock — AC 3
// -------------------------------------------------------------------------------------------

describe("vercel.json — the daily sweep (AC 3)", () => {
  const config = async () => JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8"));

  it("schedules the tick route once a day at Hobby's precision", async () => {
    expect((await config()).crons).toEqual([{ path: "/api/ladder/tick", schedule: "0 12 * * *" }]);
  });

  it("the path it names is a route that exists and answers GET", async () => {
    // Vercel Cron only ever issues GET, so a route exporting POST alone would be scheduled and
    // never act. Derived from the route file rather than asserted as prose.
    const route = join(process.cwd(), "src", "app", (await config()).crons[0].path, "route.ts");
    expect(await readFile(route, "utf8")).toMatch(/export const GET\b/);
  });
});
