import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localActionFiles, pinVerdict, readIgnores, readUses } from "../scripts/supply-chain-core.mjs";

/**
 * CI's `supply-chain` job (story #208): the rule behind each of its two steps, the one file only a
 * test reads, and the job's own lines in ci.yml.
 *
 * The job itself only ever sees this repo's real files, which are healthy, so a run of it cannot
 * tell a working check from one that passes everything. Each case here feeds a reader the input it
 * must refuse. The live proof that the job goes red is on the PR that added it: a dependency
 * downgraded, then one `uses:` put back to a tag.
 */

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function only(text: string) {
  const found = readUses(text);
  expect(found, `expected exactly one uses: in ${JSON.stringify(text)}`).toHaveLength(1);
  return found[0];
}

describe("readUses: a uses: is pinned only when it names a commit", () => {
  it("passes a 40-hex SHA with the tag kept as a comment, the form Dependabot writes", () => {
    expect(only(`      - uses: actions/checkout@${SHA} # v7`)).toEqual({
      line: 1,
      ref: `actions/checkout@${SHA}`,
      pinned: true,
    });
  });

  it.each([
    ["a tag", "actions/checkout@v7"],
    ["a full version tag", "actions/checkout@v7.0.1"],
    ["a branch", "actions/checkout@main"],
    ["a short SHA", `actions/checkout@${SHA.slice(0, 7)}`],
    ["an upper-case SHA", `actions/checkout@${SHA.toUpperCase()}`],
    ["41 hex digits", `actions/checkout@${SHA}a`],
    ["no ref at all", "actions/checkout"],
  ])("refuses %s", (_label, ref) => {
    expect(only(`      - uses: ${ref}`).pinned).toBe(false);
  });

  it("reads a quoted value, both ways round", () => {
    expect(only(`  - uses: "actions/checkout@v7"`).pinned).toBe(false);
    expect(only(`  - uses: 'actions/checkout@${SHA}'`).pinned).toBe(true);
  });

  it("reads a uses: inside a flow mapping, with no space after the brace", () => {
    expect(only(`  - {uses: actions/checkout@v7, with: {fetch-depth: 0}}`)).toMatchObject({
      ref: "actions/checkout@v7",
      pinned: false,
    });
  });

  it("reads a job-level reusable workflow, which has no dash in front of it", () => {
    expect(only(`    uses: octo/shared/.github/workflows/build.yml@v1`).pinned).toBe(false);
  });

  it("passes a local action, which comes from the commit under test", () => {
    expect(only(`      - uses: ./.github/actions/setup`).pinned).toBe(true);
  });

  it("passes a container image only when it is pinned by digest", () => {
    expect(only(`      - uses: docker://alpine:3.20`).pinned).toBe(false);
    expect(only(`      - uses: docker://alpine@sha256:${"a".repeat(64)}`).pinned).toBe(true);
  });

  it("does not read a uses: inside a comment", () => {
    expect(readUses(`      # was: uses: actions/checkout@v7`)).toEqual([]);
    expect(readUses(`# uses: actions/checkout@v7`)).toEqual([]);
  });

  it("does not read a pinned uses: that sits in the comment after a tag", () => {
    // The comment carries a whole key, so without the strip this line would read as two uses:.
    expect(only(`      - uses: actions/checkout@v7 # uses: actions/checkout@${SHA}`)).toMatchObject({
      ref: "actions/checkout@v7",
      pinned: false,
    });
  });

  it("keeps a # that is inside a quoted value, so the uses: after it is still read", () => {
    expect(only(`  - {name: "build #1", uses: actions/checkout@v7}`)).toMatchObject({
      ref: "actions/checkout@v7",
      pinned: false,
    });
    expect(only(`  - {name: 'build #1', uses: actions/checkout@v7}`).pinned).toBe(false);
  });

  it("keeps a quote escaped inside a double-quoted value from ending it", () => {
    expect(only(`  - {name: "a \\" #1", uses: actions/checkout@v7}`).ref).toBe("actions/checkout@v7");
  });

  it("reads a quoted key, both quote styles", () => {
    expect(only(`      - "uses": actions/checkout@v7`)).toMatchObject({ ref: "actions/checkout@v7", pinned: false });
    expect(only(`      - 'uses': 'actions/checkout@${SHA}'`).pinned).toBe(true);
  });

  it("reports a uses: key it cannot read as unpinned, rather than skipping it", () => {
    expect(only(`  - [uses: actions/checkout@${SHA}]`)).toEqual({ line: 1, ref: "", pinned: false });
  });

  it("refuses a uses: whose value is not on its line", () => {
    expect(only(`      - uses:`)).toEqual({ line: 1, ref: "", pinned: false });
    expect(only(`      - uses: >-`).pinned).toBe(false);
  });

  it("does not read a key that only ends in uses", () => {
    expect(readUses(`      excuses: actions/checkout@v7`)).toEqual([]);
  });

  it("numbers lines from 1 across CRLF and LF alike", () => {
    const text = [`steps:`, `  - uses: a/b@${SHA}`, `  - run: echo`, `  - uses: c/d@v1`].join("\r\n");
    expect(readUses(text).map((u) => [u.line, u.pinned])).toEqual([
      [2, true],
      [4, false],
    ]);
  });
});

describe("pinVerdict: the step's answer over every workflow file", () => {
  it("is ok when every uses: names a commit, and says how many it read", () => {
    const v = pinVerdict([
      { path: ".github/workflows/a.yml", text: `  - uses: a/b@${SHA}\n  - uses: ./local` },
      { path: ".github/workflows/b.yml", text: `  - uses: c/d@${SHA}` },
      { path: "local/action.yml", text: `runs:\n  steps:\n    - uses: e/f@${SHA}` },
    ]);
    expect(v.ok).toBe(true);
    expect(v.lines).toEqual(["action pins: all 4 uses: in 3 file(s) name a commit"]);
  });

  it("reads a local action's own steps, and names an unpinned one by its file", () => {
    const v = pinVerdict([
      { path: ".github/workflows/a.yml", text: `  - uses: ./.github/actions/setup/` },
      { path: ".github/actions/setup/action.yml", text: `runs:\n  steps:\n    - uses: actions/cache@v4` },
    ]);
    expect(v.ok).toBe(false);
    expect(v.lines).toContain("  .github/actions/setup/action.yml:3  actions/cache@v4");
  });

  it("refuses a local action whose file it was not given", () => {
    const v = pinVerdict([
      { path: ".github/workflows/a.yml", text: `  - uses: a/b@${SHA}\n  - uses: ./.github/actions/setup` },
    ]);
    expect(v.ok).toBe(false);
    expect(v.lines).toContain(
      "  .github/workflows/a.yml:2  ./.github/actions/setup (a local action whose file was not read)",
    );
  });

  it("fails and names each unpinned uses: by file and line", () => {
    const v = pinVerdict([
      { path: ".github/workflows/a.yml", text: `  - uses: a/b@${SHA}\n  - uses: a/b@v2` },
      { path: ".github/workflows/b.yml", text: `\n\n  - uses: c/d@main` },
    ]);
    expect(v.ok).toBe(false);
    expect(v.lines[0]).toBe("action pins: 2 of 3 uses: are not pinned to a 40-hex commit SHA");
    expect(v.lines).toContain("  .github/workflows/a.yml:2  a/b@v2");
    expect(v.lines).toContain("  .github/workflows/b.yml:3  c/d@main");
  });

  it("names a uses: it could not read", () => {
    const v = pinVerdict([{ path: ".github/workflows/a.yml", text: `  - uses: a/b@${SHA}\n  - [uses: c/d@${SHA}]` }]);
    expect(v.ok).toBe(false);
    expect(v.lines).toContain("  .github/workflows/a.yml:2  (a uses: whose value could not be read)");
  });

  it("fails when it read no uses: at all, because nothing was checked", () => {
    expect(pinVerdict([]).ok).toBe(false);
    const v = pinVerdict([{ path: ".github/workflows/a.yml", text: "jobs:\n  a:\n    runs-on: x" }]);
    expect(v.ok).toBe(false);
    expect(v.lines[0]).toMatch(/nothing was checked/);
  });
});

describe("localActionFiles: where a local uses: is read from", () => {
  it("reads an action directory's action.yml or action.yaml, and a reusable workflow as itself", () => {
    expect(localActionFiles("./.github/actions/setup")).toEqual([
      ".github/actions/setup/action.yml",
      ".github/actions/setup/action.yaml",
    ]);
    expect(localActionFiles("./.github/actions/setup/")).toEqual([
      ".github/actions/setup/action.yml",
      ".github/actions/setup/action.yaml",
    ]);
    expect(localActionFiles("./.github/workflows/build.yml")).toEqual([".github/workflows/build.yml"]);
  });
});

const ENTRY = [
  "[[IgnoredVulns]]",
  'id = "GHSA-aaaa-bbbb-cccc"',
  "ignoreUntil = 2026-11-25",
  'reason = "Fixed in 1.2.3: Dependabot PR #303."',
].join("\n");

describe("readIgnores: every ignore in osv-scanner.toml is dated and reasoned", () => {
  it("reads a whole entry, keeping a # inside the reason", () => {
    expect(readIgnores(`# header\n\n${ENTRY}\n`)).toEqual({
      entries: [
        {
          line: 3,
          id: "GHSA-aaaa-bbbb-cccc",
          ignoreUntil: "2026-11-25",
          reason: "Fixed in 1.2.3: Dependabot PR #303.",
        },
      ],
      problems: [],
    });
  });

  it.each([
    ["no ignoreUntil", "ignoreUntil = 2026-11-25\n", "", /entry at line 1 has no ignoreUntil date$/],
    ["no reason", 'reason = "Fixed in 1.2.3: Dependabot PR #303."', "", /entry at line 1 has no reason$/],
    ["an empty reason", '"Fixed in 1.2.3: Dependabot PR #303."', '"   "', /entry at line 1 has no reason$/],
    ["no id", 'id = "GHSA-aaaa-bbbb-cccc"\n', "", /entry at line 1 has no id$/],
    ["a quoted date", "2026-11-25", '"2026-11-25"', /must be a bare date/],
    ["a day that does not exist", "2026-11-25", "2026-02-30", /must be a bare date/],
    ["a date and time", "2026-11-25", "2026-11-25T00:00:00Z", /must be a bare date/],
    ["a misspelt key", "ignoreUntil =", "ignoreUntill =", /ignoreUntill is not one of/],
    ["a multi-line reason", '"Fixed in 1.2.3: Dependabot PR #303."', '"""', /double-quoted string on one line/],
  ])("refuses an entry with %s", (_label, from, to, problem) => {
    const text = ENTRY.replace(from, to);
    expect(text, "the fixture edit did not apply").not.toBe(ENTRY);
    const { entries, problems } = readIgnores(text);
    expect(entries).toEqual([]);
    expect(problems.join("\n")).toMatch(problem);
  });

  it("refuses an id listed twice, keeping the first", () => {
    const { entries, problems } = readIgnores(`${ENTRY}\n\n${ENTRY}`);
    expect(entries.map((e) => e.line)).toEqual([1]);
    expect(problems).toEqual(["entry at line 6 repeats GHSA-aaaa-bbbb-cccc, already listed at line 1"]);
  });

  it("refuses a key set twice in one entry", () => {
    const { problems } = readIgnores(`${ENTRY}\nignoreUntil = 2027-01-01`);
    expect(problems).toEqual(["line 5: ignoreUntil is set twice in the entry at line 1"]);
  });

  it("refuses any other table, a key outside an entry, and a line it cannot read", () => {
    const { problems } = readIgnores(
      ['reason = "loose"', "[[PackageOverrides]]", ENTRY, "not toml at all"].join("\n"),
    );
    expect(problems).toEqual([
      "line 1: reason is outside any [[IgnoredVulns]] entry",
      "line 2: [[PackageOverrides]] is not read here; only [[IgnoredVulns]] entries are",
      "line 7: cannot read this line",
    ]);
  });

  it("holds the real osv-scanner.toml: no problems, and every entry it lists was read", async () => {
    const text = await readFile(join(process.cwd(), "osv-scanner.toml"), "utf8");
    const { entries, problems } = readIgnores(text);
    expect(problems).toEqual([]);
    // The control for the line above: an entry the reader dropped without a problem would pass it.
    expect(entries).toHaveLength(text.match(/^\[\[IgnoredVulns\]\]\s*$/gm)?.length ?? 0);
  });
});

describe("ci.yml's supply-chain job", () => {
  /** A top-level job's own lines, up to the next top-level key or comment, or the end of the file. */
  async function job(name: string) {
    const yml = await readFile(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const lines = yml.split(/\r?\n/);
    const start = lines.findIndex((l) => l === `  ${name}:`);
    expect(start, `ci.yml has no top-level \`${name}:\` job`).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return { yml, job: lines.slice(start, end === -1 ? undefined : end).join("\n") };
  }

  /** The job's steps in order, each as its own text, split at every `      - ` item. */
  async function steps() {
    const { job: j } = await job("supply-chain");
    const parts = j.split(/^(?= {6}- )/m).slice(1);
    expect(parts.length, "the supply-chain job has no steps").toBeGreaterThan(0);
    return parts;
  }
  /** The one step whose text contains `needle`, with its position. */
  async function step(needle: string) {
    const all = await steps();
    const hits = all.map((text, index) => ({ text, index })).filter((s) => s.text.includes(needle));
    expect(hits, `expected one supply-chain step containing ${needle}`).toHaveLength(1);
    return { ...hits[0], all };
  }

  it("gets the workflow's contents: read floor and nothing of its own", async () => {
    const { yml, job: j } = await job("supply-chain");
    expect(yml).toMatch(/^permissions:\r?\n {2}contents: read\r?\n(?! )/m);
    expect(j).not.toMatch(/permissions:/);
  });

  it("runs the pin check from this repo's script", async () => {
    const { job: j } = await job("supply-chain");
    expect(j).toMatch(/^ {8}run: node scripts\/check-action-pins\.mjs$/m);
  });

  it("downloads one osv-scanner release and refuses the binary unless its SHA-256 matches", async () => {
    const { job: j } = await job("supply-chain");
    expect(j).toMatch(
      /https:\/\/github\.com\/google\/osv-scanner\/releases\/download\/v\d+\.\d+\.\d+\/osv-scanner_linux_amd64/,
    );
    expect(j).toMatch(/echo "[0-9a-f]{64} {2}\$RUNNER_TEMP\/osv-scanner" \| sha256sum -c -/);
  });

  it("scans with this repo's ignore list, and only once the binary passed its check", async () => {
    const scan = await step("scan source -r");
    expect(scan.text).toContain("scan source -r --config osv-scanner.toml .");
    // The condition must name a step that exists, earlier in this job, and is the one that checks
    // the hash: an `if:` naming a missing id is skipped on every run, silently.
    const named = /if: \$\{\{ !cancelled\(\) && steps\.([\w-]+)\.outcome == 'success' \}\}/.exec(scan.text);
    expect(named, "the scan step's if: does not name the install step's outcome").not.toBeNull();
    const id = named![1];
    const install = scan.all.findIndex((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));
    expect(install, `no step in the job has id: ${id}`).toBeGreaterThan(-1);
    expect(install).toBeLessThan(scan.index);
    expect(scan.all[install]).toContain("sha256sum -c -");
  });

  it("runs the advisory steps whatever the pin check did, so a PR that breaks both sees both", async () => {
    const pins = await step("check-action-pins.mjs");
    const install = await step("sha256sum -c -");
    const scan = await step("scan source -r");
    expect(pins.text).not.toMatch(/^ {8}if:/m);
    expect(install.text).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m);
    expect(scan.text).toMatch(/^ {8}if: \$\{\{ !cancelled\(\) && /m);
    expect(pins.index).toBeLessThan(install.index);
  });
});
