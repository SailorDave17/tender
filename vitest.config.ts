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
    // …and that boot happens in `beforeAll`, which `testTimeout` does not govern. At vitest's
    // 10 s default the pglite files lose the race on a busy machine, and the failure is SILENT:
    // vitest reports a `beforeAll` timeout as SKIPPED, so the run comes back with 0 failures and
    // `success: false`, which a driver reading the failed count scores as "nothing is covered".
    // *Measured 2026-08-24 on #74*, same tree minutes apart: default → 378 passed / 73 skipped /
    // success false; at 60 s → 451 passed / 0 skipped, twice. (cairn:
    // an-absent-result-reads-as-a-clean-one, twelfth member — this is its cause here.)
    hookTimeout: 60_000,
  },
});
