import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Story #154 AC 1 — the per-page frame is gone. Twenty page files carried
 * `padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "…rem"` on their `<main>`, and
 * the build stamp a fourth copy; the shell's `[data-frame] > main` rule is the one that remains.
 * A corpus scan rather than a sentence, so a page added tomorrow with its own frame is red.
 *
 * The needles are built from fragments so this file is not its own hit (the #39(d)/#41(d)/#173(d)
 * trap — every literal under the scanned tree is corpus), and the scan is scoped to `src/`.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url)).replace(/[\\/]$/, "");
const NEEDLES = [
  ["fontFamily", ": \"system-ui"].join(""),
  ["padding", ': "2rem"'].join(""),
  ["maxWidth", ': "'].join(""),
];

function walk(dir: string, hits: string[]) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, hits);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      const text = readFileSync(p, "utf8");
      for (const needle of NEEDLES) if (text.includes(needle)) hits.push(`${p.slice(SRC.length + 1).replace(/\\/g, "/")}: ${needle}`);
    }
  }
}

describe("no page carries its own frame (#154 AC 1)", () => {
  it("no fontFamily / padding 2rem / maxWidth inline object survives under src/", () => {
    const hits: string[] = [];
    walk(SRC, hits);
    expect(hits).toEqual([]);
  });

  it("the shell's frame rule exists, so the pages did not simply lose their frame", () => {
    const css = readFileSync(`${SRC}/app/globals.css`, "utf8");
    expect(css).toMatch(/\[data-frame\] > main \{[^}]*max-width: var\(--measure\)/);
    expect(css).toMatch(/\[data-frame\] > main\[data-measure="wide"\] \{[^}]*max-width: var\(--measure-wide\)/);
  });
});
