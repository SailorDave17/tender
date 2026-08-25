/**
 * The pglite harness: applies supabase/migrations/*.sql to an in-memory Postgres and exposes a
 * way to run SQL as a Supabase role.
 *
 * Known blindness, stated rather than discovered (cairn: a-stubbed-default-cannot-report-the-
 * platform-moved-2026-08-13): this harness creates the `anon`, `authenticated` and `service_role` roles itself
 * and grants nothing Supabase would not, but it cannot see a grant the live project has and the
 * migrations lack. `npm run check:live` is the instrument for the live project.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
}

/** The one file whose name starts with `prefix` — throws when that is not exactly one. */
async function fileFor(prefix: string): Promise<string> {
  const hits = (await migrationFiles()).filter((f) => f.startsWith(prefix));
  if (hits.length !== 1) {
    throw new Error(`migration prefix "${prefix}" matches ${hits.length} files: [${hits.join(", ")}]`);
  }
  return hits[0];
}

/** Apply one migration by number prefix, to a db built with `through:`. */
export async function applyMigration(db: PGlite, prefix: string): Promise<void> {
  await db.exec(await readFile(join(MIGRATIONS, await fileFor(prefix)), "utf8"));
}

export type FreshDbOptions = {
  /**
   * Stop after the migration whose name starts with this prefix, so a fixture can exist BEFORE a
   * later migration runs — the only way to test a backfill or a renumber, since the default form
   * applies every file before any test can insert a row (the trap #64's AC 2 walked into).
   *
   * An unmatched prefix THROWS rather than falling back to "apply everything": the fallback is
   * indistinguishable from the option working, and the test would then assert a post-migration
   * state while believing it was pre-migration.
   */
  through?: string;
  /**
   * Override the boot budget, for the guard test only — so the "a broken harness says which stage
   * stalled" claim can be proven through `freshDb()` itself in milliseconds, rather than against
   * `withBudget` in isolation. Testing the helper alone would certify the helper and say nothing
   * about whether `freshDb` still passes it a budget or still names its stages (cairn:
   * prove-a-guard-test-can-fail, twelfth outcome — a control that re-implements the call).
   */
  budgetMs?: number;
  /**
   * Called with each stage description as `freshDb()` enters it, for the guard test only.
   *
   * It exists because the stage labels are otherwise **executed constantly and observed by
   * nothing**: the migration-loop label below runs eleven times on every call, so a coverage
   * report shows it fully covered, while no assertion anywhere reads a budget message produced
   * during a migration. Deleting that label, or making the recorder first-write-wins, both
   * score zero red — and both ship a harness that reports a wedge applying `0009` as a boot
   * stall, which is the busy-machine-versus-broken-harness confusion this whole file exists to
   * end. Tuning a budget to expire mid-migration would observe it too, and would be flaky by
   * construction: the table above records 1401–9140 ms of every call as boot.
   */
  onStage?: (description: string) => void;
};

/**
 * How long `freshDb()` gives itself before it calls the boot BROKEN rather than SLOW — and the
 * measurement the number comes from, because #78 AC 3 asks for a justified value rather than a
 * round one.
 *
 * *Measured 2026-08-25* on this machine (24 cores, 64 GB, Node 24), `freshDb()` wall time over
 * 42 calls per condition — three consecutive `npm test` runs, the twelve pglite files starting
 * in parallel, timings appended per call from inside the function:
 *
 *   condition                    min    p50    p90     max
 *   idle                        1479   5323   6119    6232
 *   24 busy-spin CPU workers    1468   8456   9677   10134
 *
 * Two things fall out of that table. The boot dominates — 1401–9140 ms of every call is
 * constructing the WASM Postgres and running the role/schema shim, against 62–1498 ms to apply
 * the eleven migrations — so this is a startup cost, not a schema cost, and it will not shrink
 * as migrations accumulate. And vitest's 10 000 ms default sat BELOW the worst case the harness
 * produces under load (10 134 ms), which is the whole of #78: the boundary ran right through the
 * observed maximum, so whether the suite passed was a fact about what else the machine was doing.
 *
 * *Measured on CI 2026-08-25* (`ubuntu-latest`, run 32874204521), because a budget calibrated on
 * one developer's machine is a local gate that can run a different graph: the guard test that
 * performs a full real `freshDb()` in a test body took **5819 ms** wall — boot, all eleven
 * migrations and the close. So a shared runner is not slower than this box for this work, and the
 * budget has roughly 3.4x headroom there. That is the number to compare a future CI red against.
 *
 * 20 000 is that measured worst case doubled. It is deliberately far below `hookTimeout` (see
 * vitest.config.ts): the two are not redundant, they answer different questions. This budget
 * decides how long a boot may take before it is a breakage; `hookTimeout` is only the backstop
 * that must never fire first, or the message a reader gets names nothing.
 *
 * Two stated limits, because a budget that expires is not a boot that stops.
 *
 * 1. Both timers are JS timers on the worker's own thread, so neither can interrupt a boot that
 *    blocks that thread synchronously. What this catches is a boot that is slow or that never
 *    settles, which is every failure mode observed so far.
 * 2. `withBudget` **abandons** the work, it does not cancel it — there is no AbortSignal to pass
 *    a PGlite mid-boot — so on expiry a database goes on booting that no caller holds and no
 *    `afterAll` can close. That is acceptable here rather than merely tolerated: vitest's default
 *    `isolate: true` gives each file its own worker and stops it at file end, so the orphan is
 *    reaped with the worker. *Measured 2026-08-25*: roughly 180 ms in, during the boot and before
 *    any migration runs, with the guard file at 2285/2349 ms against a trivial control file at
 *    2119/2167 ms — no cascade onto the sibling pglite files, whose overlap is bounded by the
 *    teardown window rather than by their runtime.
 */
export const FRESH_DB_BUDGET_MS = 20_000;

/**
 * Run `work` under a deadline, and report WHICH STAGE was in flight when it expired.
 *
 * The point is the message, not the deadline. Without this, a harness that cannot start produces
 * vitest's `Hook timed out in 60000ms`, which names no stage, no elapsed time and nothing about
 * pglite — so it reads as "the machine is busy" whether the machine is busy or the harness is
 * broken, and those route to opposite actions.
 *
 * Exported so the guard test can drive it with a short budget instead of waiting 20 s.
 */
export async function withBudget<T>(
  budgetMs: number,
  work: (stage: (description: string) => void) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let inFlight = "starting up";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `freshDb() gave up after ${Date.now() - startedAt}ms while ${inFlight}. This is the ` +
            `HARNESS failing to start, not a failure of the code under test. The budget is ` +
            `FRESH_DB_BUDGET_MS in test/pglite.ts (${budgetMs}ms); see the measurement recorded ` +
            `there before raising it, and note that vitest reports a beforeAll failure as SKIPPED ` +
            `tests, so numFailedTests stays 0 — read numPendingTests and numFailedTestSuites.`,
        ),
      );
    }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work((description) => (inFlight = description)), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export async function freshDb(options: FreshDbOptions = {}): Promise<PGlite> {
  return withBudget(options.budgetMs ?? FRESH_DB_BUDGET_MS, async (stage) => {
    const note = (description: string) => {
      options.onStage?.(description);
      stage(description);
    };
    // One stage, not two, and the reason is a measurement: `new PGlite()` returns before the WASM
    // Postgres is up — it boots inside the first `exec` — so a budget of 1 ms expires here rather
    // than in the constructor, 6 times out of 6. A separate "constructing" stage would name a
    // window the thread never yields inside, so it could never be reported and would quietly
    // mis-attribute this one. This is also where the cost is: 5.2 s of a 5.3 s idle call.
    note("booting the WASM Postgres and creating the roles and the auth shim");
    const db = new PGlite();
    // The roles and the auth shim Supabase provides and pglite does not. auth.users is the one
    // column person.id references; the real table has many more and none is read here.
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to anon, authenticated;
    `);
    const stopAfter = options.through === undefined ? null : await fileFor(options.through);
    const files = await migrationFiles();
    for (const [i, f] of files.entries()) {
      note(`applying ${f} (${i + 1} of ${files.length})`);
      await db.exec(await readFile(join(MIGRATIONS, f), "utf8"));
      if (f === stopAfter) break;
    }
    return db;
  });
}

/**
 * Run `sql` as a Supabase role, optionally as a signed-in user. service_role (since 0010) is
 * created `bypassrls`, as Supabase's is, so a case against it measures grants alone.
 */
export async function as(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  sql: string,
  userId?: string,
) {
  await db.exec(`set role ${role};`);
  // Always set the claim, to '' when there is no user: set_config is session-wide, so a call with
  // no userId after a call with one would otherwise still run as that user.
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role;`);
  }
}
