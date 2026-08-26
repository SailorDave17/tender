import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vitestConfig from "../vitest.config";
import { FRESH_DB_BUDGET_MS, freshDb, withBudget } from "./pglite";

/**
 * Story #78 — the pglite harness must fail LOUDLY when it cannot start, and the repair for the
 * flake must be one remedy rather than two.
 *
 * The thing being guarded is not a behaviour of the product; it is a property of the instrument
 * every other pglite file rests on, and its failure mode is a run that looks like a finding.
 * *Measured 2026-08-25* by breaking `freshDb()` on purpose — once so it throws, once so it never
 * settles — and reading vitest's own JSON. Totals are left out on purpose; they move every time a
 * test is added, and these fields do not:
 *
 *   healthy            0 failed /   0 pending /  0 suites failed / true  / exit 0 /  ~11 s
 *   broken, throws     4 failed / 156 pending / 19 suites failed / false / exit 1 /    3 s
 *   broken, never      3 failed / 156 pending / 19 suites failed / false / exit 1 /   82 s
 *   settles
 *
 * **Read the two numbers in the right order.** The twelve pglite files call `freshDb()` in
 * `beforeAll`, and they contribute **nothing** to `numFailedTests` in either arm — vitest reports
 * a `beforeAll` failure as its tests SKIPPED. Every failure in that column comes from the handful
 * of tests that call `freshDb()` inside a test BODY, where a failure is an ordinary failure. So
 * `numFailedTests` moving is a side effect of how a few tests happen to be written, not a
 * property of the harness; take those away and a dead harness reads as zero failures.
 *
 * What is reliable is the rest of the row — `numPendingTests`, `numFailedTestSuites`, `success`
 * and the exit code — which move in both arms regardless. That is why cairn's tender overlay
 * refuses a run with `numPendingTests > 0` before reading any count off it, and why #78 AC 5
 * keeps that rule whatever the timeout becomes: a timeout changes when the harness gives up,
 * never how vitest accounts for it. #92 tracks giving that signal a home of its own.
 *
 * The hang case also priced the backstop: with `hookTimeout: 60_000` and nothing else, a
 * `freshDb()` that never settles took **182 s** against a healthy run's 12 s, and printed nothing
 * at all on the console under `--reporter=json`. `FRESH_DB_BUDGET_MS` is what stops a real
 * breakage riding that whole 60 s, and it must lose to nothing.
 */

const config = vitestConfig as { test?: Record<string, unknown> };

describe("the freshDb budget reports what stalled", () => {
  it("names the stage that was in flight when it expired", async () => {
    const failure = await withBudget(20, async (stage) => {
      // TWO stages, not one: with a single call, a first-write-wins recorder is indistinguishable
      // from a last-write-wins one, and first-write-wins is what ships a migration stall reported
      // as a boot stall. The `onStage` test below cannot cover this — it records every stage
      // independently of the message, so it is blind to which one the message ends up naming.
      stage("booting the WASM Postgres and creating the roles and the auth shim");
      stage("applying 0007_answer.sql (7 of 11)");
      await new Promise(() => {}); // never settles, the way a wedged WASM boot does not
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(failure, "the budget must expire rather than hang forever").not.toBeNull();
    // The stage is the whole point: without it the reader cannot tell a busy machine from a
    // broken harness, and those route to opposite actions.
    expect(failure!.message).toContain("applying 0007_answer.sql (7 of 11)");
    // …and the LATEST stage, not the first one it was ever handed.
    expect(failure!.message).not.toContain("booting the WASM Postgres");
    expect(failure!.message).toMatch(/gave up after \d+ms/);
    // …and it must say where the number lives, or the next person raises the wrong one.
    expect(failure!.message).toContain("FRESH_DB_BUDGET_MS");
    // Positive control: the same call with work that finishes must NOT reject, or this test
    // would pass against a `withBudget` that rejects unconditionally.
    await expect(withBudget(20, async () => "done")).resolves.toBe("done");
  });

  it("reports through freshDb() itself, not only through the helper", async () => {
    // AC 4 is about `freshDb()`, so the claim is proven through it rather than against
    // `withBudget` in isolation: a control that re-implements the call certifies the helper and
    // says nothing about whether `freshDb` still passes a budget or still names its stage
    // (cairn: prove-a-guard-test-can-fail, twelfth outcome).
    const failure = await freshDb({ budgetMs: 1 }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(failure, "a 1 ms budget must expire before a WASM Postgres can boot").not.toBeNull();
    // *Measured 2026-08-25*, 6 of 6: `new PGlite()` returns before the database is up, so the
    // stage in flight at 1 ms is always the boot, never a migration.
    expect(failure!.message).toContain("booting the WASM Postgres");
    // The budget in the message must be the one that was actually applied — otherwise `budgetMs`
    // could be ignored and this test would still pass on the 20 s default, slowly.
    expect(failure!.message).toContain("(1ms)");
  });

  it("names each migration as it applies it, not only the boot", async () => {
    // Without this, the migration-loop label is executed eleven times on every freshDb() call in
    // the repo and READ BY NOTHING — a coverage report shows it fully covered while deleting it,
    // or making the recorder first-write-wins, both redden zero. Either mutation ships a harness
    // that reports a wedge applying 0009 as a boot stall, which is precisely the busy-machine
    // versus broken-harness confusion this file exists to end.
    const stages: string[] = [];
    const db = await freshDb({ onStage: (s) => stages.push(s) });
    await db.close();

    expect(stages[0]).toContain("booting the WASM Postgres");
    // The last-write-wins property is the one that separates a migration stall from a boot stall,
    // so assert the LAST stage is a migration rather than merely that migrations appear.
    expect(stages.at(-1)).toMatch(/^applying \d{4}_\S+\.sql \(\d+ of \d+\)$/);
    // One label per migration on disk, and the count is read from the same place freshDb reads it
    // rather than spelled here, so adding a migration does not need this line edited.
    const applied = stages.filter((s) => s.startsWith("applying"));
    expect(applied).toHaveLength(stages.length - 1);
    expect(applied.length).toBeGreaterThan(1);
  });

  it("lets work that finishes inside the budget through untouched", async () => {
    await expect(
      withBudget(FRESH_DB_BUDGET_MS, async (stage) => {
        stage("doing something quick");
        return 42;
      }),
    ).resolves.toBe(42);
  });
});

describe("the two timers stay in the order the repair depends on", () => {
  it("keeps hookTimeout above the freshDb budget, so the diagnostic wins the race", () => {
    const hookTimeout = config.test?.hookTimeout;
    expect(typeof hookTimeout, "vitest.config.ts must set hookTimeout explicitly").toBe("number");
    // If this inverts, a stalled boot is reported by vitest as `Hook timed out in Nms`, which
    // names no stage and no elapsed time — and every test here still passes, which is exactly
    // why the ordering is asserted rather than left to whoever edits the config next.
    expect(hookTimeout as number).toBeGreaterThan(FRESH_DB_BUDGET_MS);
  });

  it("keeps testTimeout above the budget too, for the freshDb calls in test bodies", () => {
    // `hookTimeout` governs `beforeAll`; the calls in `competence-scale.test.ts` and the one
    // below sit in test BODIES, where `testTimeout` is the governing limit instead. The likely
    // way this inverts is not someone lowering testTimeout — it is someone RAISING the budget,
    // which the error message and the FRESH_DB_BUDGET_MS docblock both invite. Past 30 s the
    // hookTimeout assertion above still passes while testTimeout starts winning the race at
    // those sites, so the guard would be blind from exactly the side the code points you at.
    const testTimeout = config.test?.testTimeout;
    expect(typeof testTimeout, "vitest.config.ts must set testTimeout explicitly").toBe("number");
    expect(testTimeout as number).toBeGreaterThan(FRESH_DB_BUDGET_MS);
  });

  it("keeps the budget above the slowest boot measured under contention", () => {
    // 10 134 ms, measured 2026-08-25 over 42 calls with 24 busy-spin workers on a 24-core box.
    // The old vitest default of 10 000 ms sat below this, which is the defect in #78.
    const SLOWEST_MEASURED_MS = 10_134;
    expect(FRESH_DB_BUDGET_MS).toBeGreaterThan(SLOWEST_MEASURED_MS);
  });
});

const POOL_KEYS = ["poolOptions", "maxWorkers", "minWorkers", "maxThreads", "fileParallelism", "pool"] as const;

describe("the repair addresses one cause, not two", () => {
  // #78 AC 2: the two remedies trade against each other, so the config must visibly pick one.
  // Two independent instruments, because each is blind to what the other sees.

  it("sets no pool key in the resolved config object", () => {
    // Lexer-immune, and the stronger of the two: nothing about how the file is written can fool
    // it. Blind to a key set to vitest's own default value, which is why the source check exists.
    for (const key of POOL_KEYS) {
      expect(config.test?.[key], `${key} narrows the pool; #78's repair is the raised hook timeout alone`).toBeUndefined();
    }
    // Positive control: this reader must actually be reading the config, or every line above
    // passes against an empty object. Deliberately a key no other assertion here owns, and not
    // one of the timeouts, whose values are expected to move as the measurement does.
    expect(config.test?.environment).toBe("node");
  });

  it("names no pool key in the source of vitest.config.ts", () => {
    // Catches a key written as vitest's own default, which the resolved object cannot distinguish
    // from an absent one.
    //
    // Stripped LINE BY LINE, with no block-comment pass. A `/* … */` regex is a naive lexer whose
    // boundaries come from the file it is reading, and this config is full of `/**/` inside glob
    // patterns. *Measured 2026-08-25*: the block pass deleted the whole `include:` line — real
    // configuration, silently — and with an `exclude` glob split across two sites, which is
    // idiomatic vitest rather than contrived, it swallowed `poolOptions` and `maxThreads` and
    // every assertion below passed green. This file contains no block comments, so the pass only
    // ever removed configuration. (cairn: a-guard-that-reads-source-must-survive-its-own-docs —
    // match the scan to the guard's subject.)
    const source = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");
    const body = source.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    for (const key of POOL_KEYS) {
      expect(body, `${key} narrows the pool; #78's repair is the raised hook timeout alone`).not.toContain(key);
    }
    // Positive control: every real key must survive the strip, not just the last one. Asserting
    // only `hookTimeout` detects "the stripper ate the whole file" and never "ate the middle",
    // and the middle is the only way this guard goes green while being wrong.
    for (const key of ["include", "environment", "testTimeout", "hookTimeout"]) {
      expect(body, `the stripper removed real configuration (${key})`).toContain(key);
    }
    // …and a positive control on the STRIP itself, because the one above cannot see the failure
    // that actually happened. The block-comment pass this replaced ate the `/**/` inside the
    // include globs — *measured*, it deleted them — while every key NAME survived, because a key
    // sits before its value. So a key-name control reddens on nothing here. Derived from the
    // source rather than spelled out, so changing a glob does not need this line edited; it is
    // vacuous if the config ever contains no `/**/` at all, which is stated rather than hidden.
    const globsThatLookLikeComments = (s: string) => s.split("/**/").length - 1;
    expect(
      globsThatLookLikeComments(body),
      "the strip removed glob syntax it mistook for a block comment",
    ).toBe(globsThatLookLikeComments(source));
  });
});
