import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config";
import { CHROME_CLOSE_TIMEOUT_MS, WORST_MEASURED_CLOSE_MS } from "./chrome";

/**
 * Story #247 — every test file that launches Chrome gives its `afterAll` room to close it.
 *
 * AC 3 asks for the covered files to be FOUND, not listed, so this walks every file vitest runs
 * (`src/**` and `test/**` test files) for a Chrome launch. Then it holds each one to closing in
 * an `afterAll` that passes `CHROME_CLOSE_TIMEOUT_MS`. A new Chrome-backed file that closes
 * under the config's 60 s `hookTimeout` reddens here, rather than as a failed suite with no
 * failed test on some busy afternoon.
 *
 * The needles are built from pieces, so this file does not find itself (#99, #234).
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const LAUNCH = new RegExp(["chromium", "\\.(launch|launchPersistentContext)\\("].join(""));
const HOOK = ["after", "All("].join("");
const COVERED = ["}, ", "CHROME_CLOSE_TIMEOUT_MS", ");"].join("");

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : testFiles(p);
    return /\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const rel = (p: string) => p.slice(ROOT.length + 1);
const count = (text: string, needle: string) => text.split(needle).length - 1;

const chromeFiles = [...testFiles(`${ROOT}/src`), ...testFiles(`${ROOT}/test`)]
  .filter((p) => LAUNCH.test(readFileSync(p, "utf8")))
  .map(rel)
  .sort();

describe("Chrome-backed test files close their browser inside a timeout that covers it (#247)", () => {
  it("finds them by search, and the search finds the five known on 2026-09-24", () => {
    console.log(`#247 Chrome-backed test files: ${chromeFiles.join(", ")}`);
    // A known answer, so a search that matches nothing cannot pass the next test vacuously.
    expect(chromeFiles).toEqual(
      expect.arrayContaining([
        "test/footer-streaming.test.ts",
        "test/install-sheet.test.ts",
        "test/reduced-motion.test.ts",
        "test/shell-focus.test.ts",
        "test/surfaces.test.ts",
      ]),
    );
  });

  it("every one closes in an afterAll given CHROME_CLOSE_TIMEOUT_MS, and every afterAll it has is given it", () => {
    const uncovered = chromeFiles.filter((f) => {
      const text = readFileSync(`${ROOT}/${f}`, "utf8");
      const hooks = count(text, HOOK);
      return hooks === 0 || count(text, COVERED) !== hooks;
    });
    expect(uncovered, "Chrome-backed files whose afterAll runs under the default hookTimeout").toEqual([]);
  });

  it("the timeout outlasts the slowest close measured and the config's hookTimeout", () => {
    const hookTimeout = vitestConfig.test?.hookTimeout as number;
    expect(CHROME_CLOSE_TIMEOUT_MS).toBeGreaterThan(WORST_MEASURED_CLOSE_MS);
    expect(CHROME_CLOSE_TIMEOUT_MS).toBeGreaterThan(hookTimeout);
  });
});
