/**
 * The half of CI's `supply-chain` job that decides things, with no filesystem in it. Story #208,
 * from security-audit 2026-09-22.
 *
 * TWO RULES, ONE PER FUNCTION
 *
 * `readUses` — every `uses:` in a workflow names a COMMIT. A tag or a branch is a pointer its owner
 * can move, so `actions/checkout@v7` runs whatever v7 points at on the day the job runs. That is
 * the shape of the tj-actions/changed-files compromise (March 2025), where the attacker moved the
 * action's version tags to a commit that printed the runner's secrets. A 40-hex SHA cannot be moved.
 * The audit pinned every action in this repo, and Dependabot keeps the SHAs current. This rule keeps
 * a new step from arriving unpinned. `scripts/check-action-pins.mjs` runs it over
 * `.github/workflows/`, and over the `action.yml` of every local action those files call, since a
 * composite action's own steps run with the same token.
 *
 * `readIgnores` — every entry in `osv-scanner.toml` is DATED and REASONED. The job's advisory step
 * fails on any known advisory the file does not list, so the file is the one way to let an
 * advisory through, and an entry with no `ignoreUntil` would let it through forever.
 * `test/supply-chain.test.ts` runs this over the real file.
 *
 * BOTH FAIL CLOSED
 *
 * Neither is a parser for its whole language. Each reads the narrow shape this repo writes, and
 * whatever it cannot read counts as a failure rather than being skipped. A `uses:` key whose value
 * cannot be read, a local action whose file was not read, or an osv line that is not one of the
 * three keys, is reported. Skipping it would read exactly like a clean file.
 */

/** A commit SHA as GitHub prints it and Dependabot writes it: 40 lowercase hex, ending the ref. */
const COMMIT = /@[0-9a-f]{40}$/;
/** A container image pinned by digest, the docker:// equivalent of a commit. */
const DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
/**
 * `uses:` as a key: at the start of a line, after `- `, or inside a flow mapping `{uses: …}`, bare
 * or quoted (`"uses":` is the same key to YAML). The value is the run of characters after it, less
 * any opening quote.
 */
const USES = /(?:^|[\s{,])(["']?)uses\1\s*:\s*["']?([^\s"',}]*)/g;
/**
 * Anything that looks like a `uses:` key, however it is written. Counted against USES on the same
 * line: a key this sees and USES does not read is reported as unreadable, never skipped.
 */
const ANY_USES_KEY = /\buses["']?\s*:/g;

/**
 * A line with its YAML comment removed. A `#` starts a comment only outside quotes and only at the
 * start of the line or after whitespace, so `name: "build #1"` keeps its `#` and whatever follows.
 * An apostrophe inside a plain scalar is read as opening a quote, which keeps more of the line than
 * YAML would: that can only make the reader see a `uses:` YAML does not, which errs toward a report.
 *
 * @param {string} line
 */
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * Every `uses:` in one workflow or action file, each marked pinned or not.
 *
 * Comments are dropped first, so a `uses:` quoted in a comment is not read. A local action (`./…`)
 * counts as pinned here, because it is read from this checkout, which is already the commit under
 * test. Its own file still has to be read: `pinVerdict` refuses a local action it was not given.
 *
 * @param {string} text
 * @returns {{ line: number, ref: string, pinned: boolean }[]}
 */
export function readUses(text) {
  /** @type {{ line: number, ref: string, pinned: boolean }[]} */
  const found = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw);
    const read = [...line.matchAll(USES)];
    for (const m of read) {
      const ref = m[2];
      found.push({
        line: i + 1,
        ref,
        pinned: ref.startsWith("./") || COMMIT.test(ref) || DIGEST.test(ref),
      });
    }
    const keys = [...line.matchAll(ANY_USES_KEY)].length;
    for (let k = read.length; k < keys; k++) found.push({ line: i + 1, ref: "", pinned: false });
  });
  return found;
}

/**
 * The files a local action ref is read from, relative to the repo root: a reusable workflow is its
 * own file, and an action directory holds `action.yml` or `action.yaml`.
 *
 * @param {string} ref a `uses:` value starting `./`
 * @returns {string[]}
 */
export function localActionFiles(ref) {
  const path = ref.replace(/^\.\//, "").replace(/\/+$/, "");
  return /\.ya?ml$/.test(path) ? [path] : [`${path}/action.yml`, `${path}/action.yaml`];
}

/**
 * The pin verdict over a set of workflow and action files.
 *
 * No `uses:` at all is a failure. A directory that is read wrongly and a tree with nothing to pin
 * would otherwise look the same, and only one of them is clean. A local action counts as pinned only
 * when its own file is among `files`, so an unpinned step inside it cannot pass unread.
 *
 * @param {{ path: string, text: string }[]} files
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function pinVerdict(files) {
  const paths = new Set(files.map((f) => f.path));
  const uses = files.flatMap((f) =>
    readUses(f.text).map((u) => {
      const unread = u.ref.startsWith("./") && !localActionFiles(u.ref).some((p) => paths.has(p));
      return { ...u, path: f.path, pinned: u.pinned && !unread, unread };
    }),
  );
  if (uses.length === 0) {
    return {
      ok: false,
      lines: [`action pins: no uses: found in ${files.length} file(s), so nothing was checked`],
    };
  }
  const unpinned = uses.filter((u) => !u.pinned);
  if (unpinned.length === 0) {
    return {
      ok: true,
      lines: [`action pins: all ${uses.length} uses: in ${files.length} file(s) name a commit`],
    };
  }
  /** @param {{ ref: string, unread: boolean }} u */
  const what = (u) =>
    u.unread ? `${u.ref} (a local action whose file was not read)` : u.ref || "(a uses: whose value could not be read)";
  return {
    ok: false,
    lines: [
      `action pins: ${unpinned.length} of ${uses.length} uses: are not pinned to a 40-hex commit SHA`,
      ...unpinned.map((u) => `  ${u.path}:${u.line}  ${what(u)}`),
      "Pin each one to the commit its tag points at, and keep the tag as a comment:",
      "  uses: owner/repo@<40-hex sha> # vN",
    ],
  };
}

/** The three keys an entry may carry, and the only table this repo writes. */
const IGNORE_KEYS = new Set(["id", "ignoreUntil", "reason"]);
const ENTRY_HEADER = /^\[\[IgnoredVulns\]\]$/;
/** `key = value`, where the value may be followed by a comment. */
const KEY_VALUE = /^([A-Za-z]+)\s*=\s*(.*)$/;
/** A basic TOML string with no escapes beyond \" and \\, then an optional comment. */
const STRING = /^"((?:[^"\\]|\\["\\])*)"\s*(?:#.*)?$/;
/** A bare TOML local date, which is what osv-scanner reads `ignoreUntil` as. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})\s*(?:#.*)?$/;

/**
 * Every `[[IgnoredVulns]]` entry in `osv-scanner.toml`, and everything wrong with the file.
 *
 * An entry needs an `id`, an `ignoreUntil` that is a real calendar date, and a non-empty `reason`.
 * An id listed twice is a problem, because the second entry's date and reason are not the ones a
 * reader of the first will see. Any other table, any other key, and any line this cannot read are
 * problems too: this file is read for one shape, and a line outside it is one nobody checked.
 *
 * @param {string} text
 * @returns {{ entries: { line: number, id: string, ignoreUntil: string, reason: string }[], problems: string[] }}
 */
export function readIgnores(text) {
  /** @type {{ line: number, fields: Record<string, string> }[]} */
  const blocks = [];
  /** @type {string[]} */
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (ENTRY_HEADER.test(line)) {
      blocks.push({ line: n, fields: {} });
      return;
    }
    if (line.startsWith("[")) {
      problems.push(`line ${n}: ${line} is not read here; only [[IgnoredVulns]] entries are`);
      return;
    }
    const kv = KEY_VALUE.exec(line);
    if (!kv) {
      problems.push(`line ${n}: cannot read this line`);
      return;
    }
    const [, key, value] = kv;
    const block = blocks.at(-1);
    if (!block) {
      problems.push(`line ${n}: ${key} is outside any [[IgnoredVulns]] entry`);
      return;
    }
    if (!IGNORE_KEYS.has(key)) {
      problems.push(`line ${n}: ${key} is not one of id, ignoreUntil, reason`);
      return;
    }
    if (key in block.fields) {
      problems.push(`line ${n}: ${key} is set twice in the entry at line ${block.line}`);
      return;
    }
    if (key === "ignoreUntil") {
      const d = DATE.exec(value);
      const day = d && new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
      if (!d || !day || day.toISOString().slice(0, 10) !== `${d[1]}-${d[2]}-${d[3]}`) {
        problems.push(`line ${n}: ignoreUntil must be a bare date such as 2026-11-25, not ${value}`);
        return;
      }
      block.fields.ignoreUntil = `${d[1]}-${d[2]}-${d[3]}`;
      return;
    }
    const s = STRING.exec(value);
    if (!s) {
      problems.push(`line ${n}: ${key} must be a double-quoted string on one line`);
      return;
    }
    block.fields[key] = s[1];
  });

  /** @type {{ line: number, id: string, ignoreUntil: string, reason: string }[]} */
  const entries = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const b of blocks) {
    const { id, ignoreUntil, reason } = b.fields;
    const missing = [
      !id && "id",
      !ignoreUntil && "ignoreUntil date",
      !reason?.trim() && "reason",
    ].filter(Boolean);
    if (missing.length > 0) {
      problems.push(`entry at line ${b.line} has no ${missing.join(", no ")}`);
      continue;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      problems.push(`entry at line ${b.line} repeats ${id}, already listed at line ${first}`);
      continue;
    }
    seen.set(id, b.line);
    entries.push({ line: b.line, id, ignoreUntil, reason });
  }
  return { entries, problems };
}
