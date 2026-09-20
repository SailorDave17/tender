import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ABSENT, PRESENT, SERVER_ENV, THROWING_NAMES, envReport } from "../scripts/server-env.mjs";

/**
 * Story #65: the declared server-env registry, held equal to what src/ actually does.
 *
 * The registry lives in scripts/ so `npm run check:live` (plain Node) can read it, and src/
 * reads names through env() — two places, which is one more than a fact should live in. This
 * file is what keeps them from drifting, the same job test/migrations-hygiene.test.ts does for
 * EXPECTED_TABLES. Without it the registry is a comment: nothing else fails when a name is
 * added to the code and not to the list, or removed from the code and left on it.
 *
 * Every hunt here is grep-shaped, so each is proven on a fixture first — a guard that reads
 * source passes happily on an empty corpus (cairn:
 * a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const SRC = join(process.cwd(), "src");

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name))
        out.push({ path: relative(SRC, f).replace(/\\/g, "/"), text: await readFile(f, "utf8") });
    }
  }
  await walk(SRC);
  return out;
}

/** Every name passed to env("…") in a file, which is the only way src/ asserts one. */
function envCalls(text: string): string[] {
  return [...text.matchAll(/\benv\(\s*["']([A-Z][A-Z0-9_]*)["']/g)].map((m) => m[1]);
}

describe("the env() scan", () => {
  it("finds a call, ignores a bare process.env read and a lookalike identifier", () => {
    expect(envCalls(`const a = env("GATE_PASS_SECRET");\n`)).toEqual(["GATE_PASS_SECRET"]);
    expect(envCalls(`env('SUPABASE_SERVICE_ROLE_KEY')\n`)).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    // A direct read is NOT an assertion — it is the thing this story replaced — so the scan must
    // not count it, or a file that degrades silently would look covered.
    expect(envCalls(`const a = process.env.OWNER_EMAIL;\n`)).toEqual([]);
    // env(name) with a variable cannot be resolved by a grep and must not be guessed at.
    expect(envCalls(`const a = env(someName);\n`)).toEqual([]);
    expect(envCalls(`const a = notEnv("NEXT_PUBLIC_SUPABASE_URL");\n`)).toEqual([]);
  });
});

describe("the registry agrees with src/ (AC 1)", () => {
  it("every name src/ asserts through env() is declared, and declared as throwing", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(0); // the corpus is not empty
    const asserted = [...new Set(files.flatMap((f) => envCalls(f.text)))].sort();
    expect(asserted.length).toBeGreaterThan(0); // and it really does contain env() calls
    expect(asserted).toEqual([...THROWING_NAMES].sort());
  });

  it("every declared name is unique and carries what its absence breaks", () => {
    const names = SERVER_ENV.map((e: { name: string }) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of SERVER_ENV as { name: string; fails: string; breaks: string }[]) {
      expect(["throws", "degrades"]).toContain(e.fails);
      // A registry entry whose `breaks` is empty tells the reader of check:live nothing, which
      // is the whole value of printing a degrading name at all.
      expect(e.breaks.length, `${e.name} says what its absence breaks`).toBeGreaterThan(20);
    }
  });

  it("the degrading names are the four the runbook numbers beyond the five", () => {
    expect(
      (SERVER_ENV as { name: string; fails: string }[]).filter((e) => e.fails === "degrades").map((e) => e.name),
    ).toEqual(["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "CRON_SECRET", "OWNER_EMAIL"]);
  });

  it("no file reads a THROWING name straight off process.env, by any spelling", async () => {
    // The two shapes this story removed, and both are silent by construction:
    //
    //   process.env.NEXT_PUBLIC_SUPABASE_URL!        src/proxy.ts — a non-null assertion is a
    //     compile-time claim that does NOTHING at runtime, so an absent name reached supabase-js
    //     and came back as "supabaseUrl is required", naming no variable of ours.
    //   process.env.GATE_PASS_SECRET ?? ""           src/auth/callback — worse than a throw: an
    //     invited member finished Google sign-up, was refused as a stray, and no log line
    //     anywhere named the variable.
    //
    // A degrading name read this way is fine and deliberate — that is what degrading MEANS — so
    // the scan is scoped to the throwing set rather than to every declared name.
    const files = await sourceFiles();
    const offenders = files
      .flatMap((f) =>
        (THROWING_NAMES as string[])
          .filter((n) => new RegExp(`process\\.env\\.${n}\\b`).test(f.text))
          .map((n) => `${f.path}: ${n}`),
      )
      .sort();
    expect(offenders).toEqual([]);
  });

  it("the fixture proves that scan can fail", () => {
    // A grep-shaped guard passes happily on a corpus that simply has no offender in it, so the
    // pattern is exercised on one that does before the real corpus is trusted.
    const fixture = `const a = process.env.GATE_PASS_SECRET ?? "";\nconst b = process.env.NEXT_PUBLIC_SUPABASE_URL!;\n`;
    expect((THROWING_NAMES as string[]).filter((n) => new RegExp(`process\\.env\\.${n}\\b`).test(fixture))).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "GATE_PASS_SECRET",
    ]);
    // And a degrading name in the same shape is NOT an offender.
    expect((THROWING_NAMES as string[]).filter((n) => new RegExp(`process\\.env\\.${n}\\b`).test(`process.env.OWNER_EMAIL`))).toEqual([]);
  });
});

describe("check:live is actually wired to the report (AC 3)", () => {
  /**
   * The report is only an instrument if the runner calls it. Comments are stripped first for the
   * reason test/check-live-exit.test.ts gives about its own subject: a call named in prose calls
   * nothing, and this file's block comment in check-live.mjs names envReport twice.
   */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("strips a call written in prose and keeps the code around it", () => {
    expect(stripComments(`// calls envReport() in prose\nconst x = 1;\n`)).not.toContain("envReport()");
    expect(stripComments(`/* envReport() */\nfor (const l of envReport()) log(l);\n`)).toContain("envReport()");
  });

  it("calls envReport, and calls it BEFORE the early exit", async () => {
    const src = stripComments(await readFile(join(process.cwd(), "scripts", "check-live.mjs"), "utf8"));
    const call = src.indexOf("envReport()");
    const exit = src.indexOf("process.exit(");
    expect(call, "check-live.mjs calls envReport()").toBeGreaterThan(-1);
    expect(exit, "check-live.mjs still has its early exit").toBeGreaterThan(-1);
    // Ordering is the whole point: the run that most needs the report is the one about to refuse
    // for a missing name, and a report printed after an early exit is one nobody in trouble sees.
    expect(call).toBeLessThan(exit);
  });
});

describe("envReport (AC 3)", () => {
  const full = Object.fromEntries(SERVER_ENV.map((e: { name: string }) => [e.name, "x"]));

  it("reports one line per name and never a value", () => {
    const lines = envReport({ ...full, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_do_not_print_me" });
    expect(lines.length).toBe(SERVER_ENV.length + 1);
    expect(lines.join("\n")).not.toContain("sb_secret_do_not_print_me");
    for (const e of SERVER_ENV as { name: string }[]) {
      expect(lines.some((l: string) => l.includes(`${e.name}: `))).toBe(true);
    }
  });

  it("an empty value reads ABSENT, matching env()", () => {
    // .env.local really does carry SUPABASE_SERVICE_ROLE_KEY with an empty value, so an
    // instrument that called that `present` would disagree with the code on the live case.
    const lines = envReport({ ...full, SUPABASE_SERVICE_ROLE_KEY: "" });
    // The DETAIL line, not the summary — the summary names it too, so a loose find() here would
    // pass on a report whose per-name line still read `present`.
    expect(lines.find((l: string) => l.includes("SUPABASE_SERVICE_ROLE_KEY: "))).toContain(ABSENT);
  });

  it("the first line says how many are present and separates loud from quiet", () => {
    const { OWNER_EMAIL: _o, SUPABASE_SERVICE_ROLE_KEY: _s, ...some } = full;
    const head = envReport(some)[0];
    expect(head).toContain(`${SERVER_ENV.length - 2}/${SERVER_ENV.length}`);
    expect(head).toContain("throw (SUPABASE_SERVICE_ROLE_KEY)");
    expect(head).toContain("degrade silently (OWNER_EMAIL)");
  });

  it("a complete environment says so on the first line and marks every name present", () => {
    const lines = envReport(full);
    expect(lines[0]).toBe(`env: all ${SERVER_ENV.length} server names present`);
    expect(lines.slice(1).every((l: string) => l.includes(PRESENT))).toBe(true);
    expect(lines.join("\n")).not.toContain(ABSENT);
  });

  it("reads the real process.env by default without throwing on any of them", () => {
    // The report must never be the thing that breaks the run it is reporting on.
    expect(() => envReport()).not.toThrow();
    expect(envReport().length).toBe(SERVER_ENV.length + 1);
  });
});
