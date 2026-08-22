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
  },
});
