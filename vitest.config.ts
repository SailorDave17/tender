import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // tsconfig's `@/*` → `./src/*`, so a test can import app modules that import each other by alias.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000, // pglite's first boot downloads nothing but compiles a WASM Postgres

    // ---------------------------------------------------------------------------------------
    // Issue #78 asks which of two causes the repair addresses, and forbids doing both silently.
    // THIS REPAIR GIVES THE HOOK MORE TIME. It does not reduce how many pglite instances start
    // at once: there is deliberately no `pool`, `poolOptions`, `maxWorkers`, `maxThreads` or
    // `fileParallelism` key anywhere in this file, so file parallelism is vitest's default and
    // the twelve pglite files still start together. `test/harness-budget.test.ts` asserts that
    // absence, so the "not both" half is enforced rather than promised — the two remedies trade
    // against each other (a raised timeout hides a real hang, a narrowed pool taxes every run,
    // including the healthy ones), and doing both would leave neither cost attributable.
    //
    // …and the hook is what needed the time, because the boot happens in `beforeAll`, which
    // `testTimeout` does not govern. At vitest's 10 s default the pglite files lose the race on a
    // busy machine, and the failure is SILENT in the direction that matters: vitest reports a
    // `beforeAll` timeout as SKIPPED, so the run comes back with 0 failures and `success: false`,
    // which a driver reading the failed count scores as "nothing is covered".
    //
    // *Measured 2026-08-24 on #74*, same tree minutes apart: default → 378 passed / 73 skipped /
    // success false; at 60 s → 451 passed / 0 skipped, twice. (cairn:
    // an-absent-result-reads-as-a-clean-one, twelfth member — this is its cause here.)
    //
    // *Measured 2026-08-25 on #78*, the number behind that: `freshDb()` takes 1479–6232 ms idle
    // and 1468–10 134 ms under 24-way CPU contention, over 42 calls per condition. The old 10 s
    // default sat BELOW the worst case the harness produces under load, which is why the flake
    // read as a property of how recently the suite was last run. Full table and derivation are in
    // `test/pglite.ts` beside `FRESH_DB_BUDGET_MS`, which is the value that actually governs a
    // boot now (20 s = that worst case doubled).
    //
    // 60 s is a BACKSTOP, not the operative limit, and it is chosen only to sit clear of the
    // 20 s budget so `freshDb()`'s own diagnostic — which names the stage and the elapsed time —
    // wins the race against this message, which names neither. `harness-budget.test.ts` asserts
    // that ordering; without it, lowering this below the budget would quietly restore the
    // uninformative failure while every test still passed.
    hookTimeout: 60_000,
  },
});
