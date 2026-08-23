import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "./pglite";

/**
 * Two facts about the migration set that are otherwise held by hand.
 *
 * 1. The migrations record nothing from which a person's years can be inferred (story #14 AC 1).
 *    Read as files rather than through git so the check is the same under CI and locally.
 * 2. `scripts/check-live.mjs`'s EXPECTED_TABLES is the set of tables the migrations create — a
 *    copy of a fact the migrations already hold, which is the class that drifts (cairn:
 *    a-computable-claim-does-not-belong-in-prose-2026-08-07). The script cannot be imported (it
 *    probes and exits at module load), so the literal is read out of its source.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

describe("supabase/migrations — no way to infer how old a person is", () => {
  it("mentions none of the usual spellings", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(join(MIGRATIONS, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/date_of_birth|birth|\bage\b/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("check:live expects exactly the tables the migrations create", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("EXPECTED_TABLES in scripts/check-live.mjs equals public's tables in the harness", async () => {
    const src = await readFile(join(process.cwd(), "scripts", "check-live.mjs"), "utf8");
    const m = /const EXPECTED_TABLES = \[([^\]]*)\]/.exec(src);
    expect(m, "EXPECTED_TABLES literal not found in scripts/check-live.mjs").not.toBeNull();
    const expected = [...m![1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();

    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const created = r.rows.map((x) => x.tablename);
    expect(created.length).toBeGreaterThan(0);
    expect(expected).toEqual(created);
  });
});

/**
 * 3. The contact-on-match rule is pure RLS (story #21 AC 3, ADR 003's kill condition). Two
 *    readings, because each is blind to something: the migration text for the literal the AC
 *    names (`security definer` inside a person_contact policy statement), and the catalog for
 *    what the live policy set actually calls — a policy could reach a definer through a
 *    function it names without the words appearing in the statement.
 */
describe("person_contact's read path has no security definer in it (ADR 003 kill condition)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("no `create policy … on public.person_contact` statement mentions security definer", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    const statements: string[] = [];
    for (const f of files) {
      const text = await readFile(join(MIGRATIONS, f), "utf8");
      // Anchored on the policy's own name: a lazy `create policy …` would span from some other
      // table's policy to the next person_contact one and sweep a function body in between.
      for (const m of text.matchAll(/create policy\s+\w+\s+on public\.person_contact[\s\S]*?;/g)) statements.push(m[0]);
    }
    expect(statements.length).toBeGreaterThanOrEqual(2); // 0002's self-only and 0008's widening
    expect(statements.filter((s) => /security\s+definer/i.test(s))).toEqual([]);
  });

  // Which functions a policy's expressions reference, from pg_depend — the catalog's own record,
  // written when the policy is created. Not a regex over pg_policies.qual: that deparses
  // `public.f(...)` as `f(...)` whenever public is on the search_path, so a pattern expecting a
  // schema-qualified spelling saw no function at all and let a definer through (measured on
  // this test's own mutation pass, story #21).
  const functionsOf = (table: string) =>
    db.query<{ policy: string; cmd: string; fn: string; prosecdef: boolean }>(
      `select pol.polname as policy, pol.polcmd as cmd, n.nspname || '.' || p.proname as fn, p.prosecdef
         from pg_policy pol
         join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
         join pg_proc p on p.oid = d.refobjid
         join pg_namespace n on n.oid = p.pronamespace
        where pol.polrelid = '${table}'::regclass
        order by pol.polname, fn`,
    );

  it("the live person_contact SELECT policy references exactly auth.uid(), and no policy there references a definer", async () => {
    const names = await db.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public' and tablename = 'person_contact' order by policyname`,
    );
    expect(names.rows.map((p) => p.policyname)).toEqual(["person_contact_read_self_or_counterparty", "person_contact_update_self"]);
    const deps = await functionsOf("public.person_contact");
    const select = deps.rows.filter((r) => r.cmd === "r");
    expect(select.map((r) => r.fn)).toEqual(["auth.uid"]); // the read path calls nothing else
    expect(deps.rows.filter((r) => r.prosecdef)).toEqual([]); // and nothing on the table is a definer
  });

  it("positive controls: the same read sees a policy's function dependency, and sees a definer", async () => {
    // answer's policies call can_answer() — the dependency read finds it, security invoker.
    const answer = await functionsOf("public.answer");
    expect(answer.rows.map((r) => `${r.fn}:${r.prosecdef}`)).toContain("public.can_answer:false");
    // and prosecdef is visible where it is true: the schema's definers, by name.
    const definers = await db.query<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by fn`,
    );
    expect(definers.rows.map((r) => r.fn)).toEqual(["public.accept_answer", "public.answer_counts"]);
  });
});
