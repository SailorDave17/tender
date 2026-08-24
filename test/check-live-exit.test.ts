import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `check:live` must report its verdict through its exit code (story #49).
 *
 * The defect this refuses: an immediate `process.exit()` tears the process down while undici
 * still holds the keep-alive socket the probes opened, and on Windows/Node 24 libuv aborts
 * closing a handle that is already closing —
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * — which replaces the computed code with the crash code. The check reaches its subject,
 * classifies correctly, and then throws the answer away.
 *
 * WHY THIS IS A SOURCE-TEXT TEST AND NOT A RUN. *Measured 2026-08-23*, one fresh process per
 * run, against the real project: the unfixed runner aborted 30 of 30 on the key-rejected path
 * and the fixed one 0 of 30. The trigger is not timing luck — it is the number of requests made
 * before the exit, and only the first is exposed (1 request -> 30/30 aborted, 2 -> 0/30,
 * 3 -> 0/30, 5 -> 0/30, with HTTP status irrelevant: 20/20 on a 200 and 20/20 on a 401).
 *
 * None of that is reachable from here. Against a localhost target the defect did not reproduce
 * in any arm — this runner over TLS 0 of 30 with the defect present, a bare fetch 0 of 20 over
 * TLS and 0 of 40 over plain HTTP — so every harness that can run in CI or on a developer's
 * machine without live credentials is structurally blind to it, and a green streak from one
 * proves nothing (cairn: an-absent-result-reads-as-a-clean-one-2026-08-11). What CAN be held
 * here is the shape of the code, so that is what is held.
 *
 * The scan strips comments first, and that is the point rather than tidiness: this file's own
 * subject is a CALL, and a call named in a comment exits nothing. A guard whose subject is
 * source text refuses the prose explaining it unless the scan is matched to the subject
 * (cairn: a-guard-that-reads-source-must-survive-its-own-docs-2026-08-09) — and the block
 * comment above `process.exitCode` in the runner names the forbidden call twice.
 */

const SCRIPTS = join(process.cwd(), "scripts");

/** Block and line comments removed. Strings are left alone; no script here puts code in one. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

async function code(file: string): Promise<string> {
  return stripComments(await readFile(join(SCRIPTS, file), "utf8"));
}

describe("stripComments — the defence that lets this guard survive its own docs", () => {
  it("removes a forbidden call written in prose, and keeps the code around it", () => {
    // A synthetic corpus, because the real scripts deliberately do not spell the call in a
    // comment — so without this the stripper is a defence against a state the corpus does not
    // contain, byte-identical to dead code to whoever tidies up next
    // (cairn: a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
    const src = [
      "// process.exit(1) here would abort the run",
      "/* and process.exit(2) here would too",
      "   across a second line */",
      "process.exitCode = code;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).not.toMatch(/process\.exit\s*\(/);
    expect(out).toMatch(/process\.exitCode = code;/);
  });

  it("leaves a URL's // alone, so a link in the source is not read as a comment", () => {
    expect(stripComments('const u = "https://example.test/x";')).toMatch(/https:\/\/example\.test/);
  });
});

describe("check:live reports through its exit code", () => {
  it("the runner sets process.exitCode for the verdict", async () => {
    const src = await code("check-live.mjs");
    expect(src).toMatch(/process\.exitCode\s*=\s*code/);
  });

  it("the runner's only immediate exit is the pre-flight one, above the first probe", async () => {
    const src = await code("check-live.mjs");
    const exits = [...src.matchAll(/process\.exit\s*\(/g)].map((m) => m.index ?? -1);
    // Exactly one, and it must sit above the call that opens the first socket. Both halves
    // matter: a second exit anywhere is the defect, and the surviving one is safe only because
    // nothing has been fetched when it runs.
    expect(exits).toHaveLength(1);
    const firstProbe = src.indexOf("runCheck({");
    expect(firstProbe).toBeGreaterThan(-1);
    expect(exits[0]).toBeLessThan(firstProbe);
  });

  it("the core module, which is reached only after a probe, has no immediate exit at all", async () => {
    const src = await code("check-live-core.mjs");
    // Positive control, in the same test: a `not.toMatch` passes just as well on an empty read,
    // so the absence means nothing until something proves the file arrived and survived the
    // comment strip (cairn: a-stubbed-default-cannot-report-the-platform-moved-2026-08-13).
    expect(src).toMatch(/export function classify\b/);
    expect(src).not.toMatch(/process\.exit\s*\(/);
  });

  it("the expected-set module has none either", async () => {
    const src = await code("check-live-expected.mjs");
    expect(src).toMatch(/EXPECTED_TABLES/);
    expect(src).not.toMatch(/process\.exit\s*\(/);
  });

  it("the comment naming the reason is present, so the next person finds it here", async () => {
    // Deliberately read the RAW file: the reason lives in a comment, so this is the one
    // assertion whose subject is the prose rather than the code.
    const raw = await readFile(join(SCRIPTS, "check-live.mjs"), "utf8");
    expect(raw).toMatch(/UV_HANDLE_CLOSING/);
  });
});
