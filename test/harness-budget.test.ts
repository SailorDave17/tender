import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vitestConfig from "../vitest.config";
import { FRESH_DB_BUDGET_MS, freshDb, withBudget } from "./pglite";

/**
 * Story #78 — the pglite harness must fail LOUDLY when it cannot start, and the repair for the
 * flake must be one remedy rather than two.
 *
 * Story #92 — and one test whose NAME says the harness could not start, so a reader does not
 * have to infer it from tests named for stage labels and migration prefixes.
 *
 * The thing being guarded is not a behaviour of the product; it is a property of the instrument
 * every other pglite file rests on, and its failure mode is a run that looks like a finding.
 * *Re-measured 2026-08-31 on #92's tree* by breaking `freshDb()` on purpose — once so it throws,
 * once so it never settles (a hang after the boot stage is noted, which is the wedged-WASM shape)
 * — and reading vitest's own JSON. Totals are left out on purpose; they move every time a test is
 * added, and these fields do not:
 *
 *   healthy            0 failed /   0 pending /  0 suites failed / true  / exit 0 /  ~14 s
 *   broken, throws     5 failed / 189 pending / 23 suites failed / false / exit 1 /   ~3 s
 *   broken, never      4 failed / 189 pending / 23 suites failed / false / exit 1 /  ~81 s
 *   settles
 *
 * (#78 measured 4 / 3 failures against 156 pending and 19 suites on 2026-08-25. The failure
 * column gained the canary; the other columns moved because the repo gained test files.)
 *
 * **Read the two numbers in the right order.** Fifteen files call `freshDb()` in `beforeAll`
 * (*measured 2026-08-31* — that count drifts with the repo and nothing here depends on it; the
 * property does not drift), and they contribute **nothing** to `numFailedTests` in either arm —
 * vitest reports a `beforeAll` failure as its tests SKIPPED. Before #92, every failure in that
 * column came from four tests that call `freshDb()` inside a test BODY for unrelated reasons, so
 * `numFailedTests` moving was a side effect of how a few tests happen to be written rather than a
 * property of the harness — rewrite those four and a dead harness reads as zero failures again.
 * The canary at the top of this file is the fifth, and the only one that is there on purpose.
 *
 * What is reliable is the rest of the row — `numPendingTests`, `numFailedTestSuites`, `success`
 * and the exit code — which move in both arms regardless. That is why cairn's tender overlay
 * refuses a run with `numPendingTests > 0` before reading any count off it. **#92 AC 4 KEEPS that
 * rule**: it is the signal that depends on no particular test existing, and a named canary does
 * not retire it — the canary says WHAT happened, the pending count says THAT something did.
 *
 * *What the canary costs, measured 2026-08-31 over three runs each side, because it is not free:*
 *
 *   whole suite            13355 / 13660 / 13831 ms  ->  14235 / 14598 / 14630 ms   (+~0.9 s)
 *   this file alone         8384 /  8426 /  8912 ms  ->   9820 / 10202 / 10444 ms   (+~1.5 s)
 *
 * The ranges do not overlap on either row, so the cost is real rather than noise. It is also far
 * less than the ~5.3 s an idle boot takes, and the per-test durations say why: the canary boots in
 * 5790–7129 ms and `names each migration` — the SECOND boot in the same worker — fell from
 * 8341–8844 ms to 3267–3983 ms, because the WASM compile is amortised across a worker. So the
 * marginal cost of a boot is not the cost of the first one. On `ubuntu-latest` a full real
 * `freshDb()` in a test body measured 5819 ms (#78, CI run 32874204521); that is the number to
 * compare a future CI regression against.
 *
 * The hang case also priced the backstop: with `hookTimeout: 60_000` and nothing else, a
 * `freshDb()` that never settles took **182 s** against a healthy run's 12 s, and printed nothing
 * at all on the console under `--reporter=json`. `FRESH_DB_BUDGET_MS` is what stops a real
 * breakage riding that whole 60 s, and it must lose to nothing.
 */

const config = vitestConfig as { test?: Record<string, unknown> };

describe("the pglite harness", () => {
  // Story #92. The one test in the repo whose NAME is the deliverable.
  //
  // Everything else in this file guards the budget; this guards the boot itself, and it exists
  // because the signal a dead harness produces was previously INCIDENTAL. Fifteen files call
  // `freshDb()` in `beforeAll`, and vitest reports a `beforeAll` failure as its tests SKIPPED,
  // so those files contribute nothing to `numFailedTests`. Every failure in that column came
  // from the handful of tests that happen to call `freshDb()` in a test BODY for unrelated
  // reasons — two checking migration-prefix errors, two added by #78 about stage labels. A
  // reader seeing `names each migration as it applies it` red learns that something about
  // migrations broke. They do not learn that the database never started, and rewriting any of
  // those four tests takes the signal away without anyone noticing.
  //
  // So this one is named for the purpose and asserts a successful boot and NOTHING else.
  //
  // It must assert the boot SUCCEEDED, not that a broken one is reported well. The
  // `freshDb({ budgetMs: 1 })` case below is the counter-example and the reason that is spelled
  // out: it asserts a REJECTION, so it passes against a harness that never settles (*measured*
  // — it does redden against one that throws, which raises a different error, so it is half a
  // signal while reading like a whole one).
  //
  // `select 1` and no more, on purpose. It cannot redden for a schema, policy or grant reason,
  // so a red here has exactly one meaning. Anything richer would make this test a second copy
  // of whatever it queried, and would put it back in the class it exists to leave.
  //
  // FIRST in the file deliberately: the `budgetMs: 1` case below ABANDONS a database that goes
  // on booting (see `withBudget`'s stated limits in test/pglite.ts), and the one test that must
  // never cry wolf should not run alongside that orphan.
  it("boots: if this test is red the harness could not start, and the other pglite files' tests are SKIPPED rather than failed", async () => {
    const db = await freshDb();
    try {
      // Not `expect(db).toBeTruthy()`: `freshDb()` either resolves with a PGlite or rejects, so
      // that assertion could not fail and the `await` would be doing all the work. Asking the
      // database a question it can only answer once it is actually up is the weakest claim that
      // is still a claim.
      const { rows } = await db.query<{ ok: number }>("select 1 as ok");
      expect(rows[0]?.ok, "the harness resolved but the database does not answer").toBe(1);
    } finally {
      await db.close();
    }
  });
});

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
