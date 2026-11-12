#!/usr/bin/env node
/**
 * The first step of CI's `supply-chain` job (#208): fail when any `uses:` under
 * `.github/workflows/`, or in a local action one of them calls, is not pinned to a commit.
 *
 *     node scripts/check-action-pins.mjs
 *
 * Run it from the repo root, the same way CI does. It reads files and nothing else, so it needs no
 * `npm ci`. The rule and the report are in `supply-chain-core.mjs`, which `test/supply-chain.test.ts`
 * exercises. What is left here is reading the files: every workflow, then the file behind each local
 * `./` action they name, and the local actions those name in turn. A local action whose file is not
 * on disk is left out, and the verdict reports it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localActionFiles, pinVerdict, readUses } from "./supply-chain-core.mjs";

const root = process.cwd();
/** @type {Map<string, string>} repo-relative path -> text */
const files = new Map();
const queue = readdirSync(join(root, ".github", "workflows"))
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => `.github/workflows/${name}`);

while (queue.length > 0) {
  const path = /** @type {string} */ (queue.shift());
  if (files.has(path)) continue;
  const text = readFileSync(join(root, path), "utf8");
  files.set(path, text);
  for (const u of readUses(text)) {
    if (!u.ref.startsWith("./")) continue;
    const found = localActionFiles(u.ref).find((p) => existsSync(join(root, p)));
    if (found) queue.push(found);
  }
}

const { ok, lines } = pinVerdict([...files].map(([path, text]) => ({ path, text })));
for (const line of lines) (ok ? console.log : console.error)(line);
// exitCode, not exit(): the verdict is printed before the process ends (see check-live-exit).
process.exitCode = ok ? 0 : 1;
