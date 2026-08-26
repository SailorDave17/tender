import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findPolicyLiterals } from "./password-policy-literals";

/**
 * Story #100 AC 7 (source half) and AC 8. Two facts about `src/` that only a read of `src/` can
 * hold, in the shape the two guards beside it already use (`no-wildcard-club.test.ts`,
 * `notify-call-sites.test.ts`).
 *
 * AC 8: the password policy's number lives in `src/auth/password.ts` and nowhere else. Before
 * #100 it was written out in FIVE places across two files — `minLength={8}` three times, one
 * `password.length < 8` and one sentence — each of which would have gone stale independently the
 * day the policy moved.
 *
 * AC 7: the reset landing stays a Server Component and the decision stays in its Server Action.
 * `minLength={PASSWORD_MIN}` and `minLength={8}` render the same DOM, so no interactive test can
 * tell them apart; the source is the only subject there is (cairn:
 * a-guard-that-reads-source-must-survive-its-own-docs-2026-08-09, the 2026-08-16 half).
 *
 * **What this scan cannot be asked about, and why that is not a hole.** The corpus is `src/`
 * without its test files, so this file's own fixtures — which necessarily spell the shapes it
 * forbids — are outside it, and so is `src/auth/password.test.ts`, which asserts the rendered
 * sentence and must contain the number to do so. AC 8 names both exemptions. A guard whose
 * subject is a string cannot check for a string it may not contain, and the way out is to put
 * the guard where the scan does not reach rather than to weaken the scan (cairn:
 * satisfying-a-negative-claim-destroys-its-instrument-2026-08-26).
 */

const SRC = join(process.cwd(), "src");

/** The one function that decides whether two typed passwords are acceptable. */
const DECIDER = "checkNewPassword";

/** Everything under src/ that ships, which is everything that is not a test. */
async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push({ path: relative(SRC, full).replace(/\\/g, "/"), text: await readFile(full, "utf8") });
      }
    }
  }
  await walk(SRC);
  return out;
}

describe("the detector itself — proven on a fixture, in both directions", () => {
  it("finds all four shapes the policy can be written in", () => {
    const fixture = [
      `export const PASSWORD_MIN = 8;`,
      `<input name="password" type="password" minLength={8} />`,
      `if (password.length < 8) {`,
      `  setState({ message: "Choose a password of at least 8 characters." });`,
      `const props = { minLength: 12 };`,
      `<input`,
      `  minLength={10}`,
      `/>`,
    ].join("\n");
    expect(findPolicyLiterals(fixture).map((h) => h.line)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(new Set(findPolicyLiterals(fixture).map((h) => h.shape)).size, "a shape matched nothing").toBe(4);
  });

  it("ignores the corrected forms, maxLength, and an emptiness check", () => {
    const fixture = [
      `<input minLength={PASSWORD_MIN} />`,
      `<input minLength={minLength} />`,
      `minLength: number;`,
      `<input name="displayName" required maxLength={80} />`,
      `<textarea name="note" maxLength={280} rows={3} />`,
      `if (password.length < PASSWORD_MIN) {`,
      `return \`Choose a password of at least \${PASSWORD_MIN} characters.\`;`,
      // "did they type anything" is not the policy, and src/auth/password.ts really contains
      // the first of these — matching it would make this guard's one exemption look
      // load-bearing when it is not.
      `if (input.password.length === 0) return;`,
      `if (password.length > 0) return;`,
      `if (candidates.length > 0) return;`,
      `if (displayName.length < 1 || displayName.length > 80) return;`,
    ].join("\n");
    expect(findPolicyLiterals(fixture)).toEqual([]);
  });

  it("reports every hit in a file, and gives the same answer when called twice", () => {
    // Two of one shape in one file, which is the file this guard exists for. The repeat call
    // is the live control on the stored `g` regexes: `matchAll` clones and leaves `lastIndex`
    // alone — *measured*, two calls both return 2 — but `.test()`/`.exec()` advance it, and
    // one `.test` drops the next `matchAll` from 2 hits to 1. A rewrite to either reddens this.
    const fixture = [`<input minLength={8} />`, `<input minLength={8} />`].join("\n");
    expect(findPolicyLiterals(fixture).map((h) => h.line)).toEqual([1, 2]);
    expect(findPolicyLiterals(fixture).map((h) => h.line)).toEqual([1, 2]);
  });
});

describe("AC 8 — the policy number is written out in exactly one file", () => {
  it("src/ names it nowhere outside src/auth/password.ts", async () => {
    const files = await sourceFiles();
    // The corpus exists and was walked. Without this, "no hits" is equally consistent with a
    // scan that read nothing at all.
    expect(files.length, "the scan walked no files").toBeGreaterThan(40);
    expect(files.map((f) => f.path)).toContain("auth/password.ts");
    // …and the one exempt file really does DECLARE the policy — otherwise this whole guard
    // could pass against a repo where the constant had been deleted and every consumer had
    // gone with it. Asserted on the declaration shape specifically: "some hit" would have
    // been satisfied by an unrelated `length === 0` comparison in the same file.
    const owner = files.find((f) => f.path === "auth/password.ts")!;
    expect(findPolicyLiterals(owner.text).map((h) => h.shape), "the policy left its own module").toContain(
      "policy declaration",
    );

    const hits: string[] = [];
    for (const file of files) {
      if (file.path === "auth/password.ts") continue;
      for (const hit of findPolicyLiterals(file.text)) {
        hits.push(`src/${file.path}:${hit.line} (${hit.shape}): ${hit.text}`);
      }
    }
    expect(hits, "import PASSWORD_MIN from @/auth/password instead of writing the number out").toEqual([]);
  });
});

describe("AC 7 — the reset landing stays a Server Component and decides nothing", () => {
  it("keeps checkNewPassword to the two callers that own a decision", async () => {
    const files = await sourceFiles();
    const callers = files.filter((f) => f.text.includes(`${DECIDER}(`)).map((f) => f.path).sort();
    // Enumerated exactly, so a third caller is a deliberate edit to this line rather than a
    // silent third copy of the same decision. `password.ts` defines it; the Server Action decides
    // for the reset path and the Sign up handler decides for the join path — one each.
    expect(callers).toEqual(["app/join/JoinForm.tsx", "app/reset-password/actions.ts", "auth/password.ts"]);
  });

  it("leaves the page a Server Component with one PasswordFields and no hand-written inputs", async () => {
    const page = await readFile(join(SRC, "app/reset-password/page.tsx"), "utf8");
    expect(page).not.toContain("use client");
    // The CALL form, not the bare name. *Measured*: the bare name refused this page on the
    // guard's first run, because the comment explaining why the decision lives in the Server
    // Action names the function it is explaining. The claim was always about a call — match the
    // scan to the subject rather than deleting the explanation (cairn:
    // a-guard-that-reads-source-must-survive-its-own-docs-2026-08-09).
    expect(page).not.toContain(`${DECIDER}(`);
    // one instance, not two boxes wired by hand
    expect(page.match(/<PasswordFields\b/g) ?? []).toHaveLength(1);
    expect(page, "the page still writes its own password inputs").not.toMatch(/<input\b/);
    // The page still routes its error key through the explainer and INTO the component. The
    // component's own test proves it renders what it is handed; this is the other end of that
    // chain, and without it the two halves could be re-keyed in step with the suite green
    // (the four-hop lesson in cairn's tender overlay).
    expect(page, "the reset error no longer reaches the boxes").toMatch(
      /error=\{[^}]*explainResetError\(error\)/,
    );
    // Control: the component it delegates to IS a client component, or none of the toggles run.
    const component = await readFile(join(SRC, "auth/PasswordFields.tsx"), "utf8");
    expect(component.startsWith('"use client"')).toBe(true);
    expect(component, "the shared component must not decide anything").not.toContain(`${DECIDER}(`);
  });
});
