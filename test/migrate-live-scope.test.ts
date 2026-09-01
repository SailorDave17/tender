import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { TOKEN_VAR } from "../scripts/management-api.mjs";

/**
 * The personal access token stays out of version control, and stays out of the browser — #114
 * AC 11.
 *
 * This token is a wider credential than anything else this repo holds: it has authority over
 * EVERY project in the account, where the anon key is public by design and subject to RLS and the
 * service-role key is scoped to one project. So the scan is for the name existing anywhere it
 * should not, rather than only for it being used carefully where it should.
 *
 * Two hazards, and the second is this repo's own shape. A `NEXT_PUBLIC_SUPABASE_ACCESS_TOKEN`
 * anywhere would inline an account-wide credential into the browser bundle with nothing failing
 * and nothing looking wrong — `NEXT_PUBLIC_` is inlined at BUILD time (cairn:
 * nextjs-proxy-inlines-public-env-at-build-2026-08-25), and every other Supabase variable here is
 * already spelled that way, so the wrong spelling is one word from the habitual one.
 *
 * Grep-shaped, so each hunt is proven on a fixture first — a guard that reads source can pass on
 * an empty corpus (cairn: a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const ROOT = process.cwd();

/**
 * `--untracked` is load-bearing, not tidiness. A plain `git grep` reads only what is COMMITTED,
 * which is never the file a change is adding, so this assertion would pass against the committed
 * corpus while the files it names sat uncommitted in the working tree (cairn:
 * a-checks-coverage-is-not-a-completion-condition-2026-08-07, the git-corpus half). Ignored files
 * are still excluded, which is what keeps the real `.env.local` out of the scan — and that is the
 * point rather than a limitation: the token IS in `.env.local`, and `.env*` is gitignored.
 */
function trackedHits(needle: string): string[] {
  try {
    return execFileSync("git", ["grep", "--untracked", "-l", needle, "--", ":!*.test.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/\\/g, "/"))
      .sort();
  } catch {
    // `git grep` exits 1 on no matches, which is the answer rather than an error.
    return [];
  }
}

describe("the access token never reaches version control or a browser (AC 11)", () => {
  it("the scan finds a name it is looking for — the positive control", () => {
    // Without this, every assertion below would pass identically against a scan that reads
    // nothing, and the guard would be decorative.
    expect(trackedHits(TOKEN_VAR).length).toBeGreaterThan(0);
  });

  it("exactly three files name the token: the env sample, the docs, and the one module", () => {
    // `migrate-live.mjs` is deliberately NOT in this list — it imports `TOKEN_VAR` rather than
    // spelling the name, so the variable has one definition and a rename cannot leave a stale
    // literal behind. A fourth entry appearing here is a second spelling to check.
    expect(trackedHits(TOKEN_VAR)).toEqual([
      ".env.example",
      "README.md",
      "scripts/management-api.mjs",
    ]);
  });

  it("`NEXT_PUBLIC_SUPABASE_ACCESS_TOKEN` exists nowhere — the one-word slip that would ship it", () => {
    expect(trackedHits("NEXT_PUBLIC_SUPABASE_ACCESS_TOKEN")).toEqual([]);
  });

  it("nothing under src/ reads it — this is a script-only credential", () => {
    // The app never needs it, so any hit here is a credential crossing into code that ships.
    expect(trackedHits(TOKEN_VAR).filter((path) => path.startsWith("src/"))).toEqual([]);
  });

  it("`.env.example` carries the NAME and no value, and says what the token must cover", () => {
    // Read from DISK, not from the index (`git show :.env.example`). The index is whatever was
    // last staged, so an assertion against it passes on a stale copy while the working tree — the
    // thing a person opens and copies — says something else.
    const sample = readFileSync(resolve(ROOT, ".env.example"), "utf8");
    expect(sample).toMatch(new RegExp(`^${TOKEN_VAR}=$`, "m"));

    // This asserted `/EVERY PROJECT IN THE ACCOUNT/` until 2026-08-31, when three tokens measured
    // against the live project showed that claim to be false: a personal access token is scoped by
    // project and by permission. The assertion is kept, re-pointed at what a reader actually needs
    // — that the token must COVER THIS PROJECT and ALLOW WRITES — because those are the two ways it
    // was wrong in practice, each with a failure that names neither.
    expect(sample).toMatch(/SCOPED BY PROJECT AND BY PERMISSION/);
    expect(sample).toMatch(/403/); // the wrong-project failure
    expect(sample).toMatch(/25006/); // the read-only failure
  });

  it("`.env*` is gitignored, so the file holding the real value cannot be committed", () => {
    const ignored = execFileSync("git", ["check-ignore", "-v", ".env.local"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(ignored).toContain(".env");
  });
});
