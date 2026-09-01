import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { splitStatements } from "../scripts/management-api.mjs";
import {
  CONTROLS,
  HOLDS,
  INDETERMINATE,
  MISSING,
  SUMMARY_FOOTER,
  controlsQuery,
  expectationQueries,
  factSql,
  foldExpectations,
  integerLiterals,
  parseMigration,
  parseStatement,
  report,
  rolesQuery,
  runVerify,
  splitTopLevel,
  stripComments,
  verdictFor,
} from "../scripts/verify-migrations-core.mjs";
import { makeRunSql } from "../scripts/verify-migrations.mjs";
import { freshDb } from "./pglite";

import type { PGlite } from "@electric-sql/pglite";

/**
 * `npm run verify:migrations` (#117), with no live project and no credential.
 *
 * The story's own criterion is that the expectations are DERIVED from the migrations rather than
 * listed, so most of what is worth testing is the parser: what it recognises, what it refuses to
 * guess at, and what it does with prose. The end-to-end block at the bottom runs the real thing
 * against the pglite harness — the migrations applied to a real Postgres, the catalog read back —
 * which is the only instrument here that can show a generated query is valid SQL at all.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

async function corpus(): Promise<{ file: string; sql: string }[]> {
  const names = (await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (file) => ({ file, sql: await readFile(join(MIGRATIONS, file), "utf8") })));
}

// -------------------------------------------------------------------------------------------
// Stripping comments — AC 3
// -------------------------------------------------------------------------------------------

describe("stripComments", () => {
  it("removes a line comment", () => {
    expect(stripComments("select 1; -- a note\nselect 2;")).not.toContain("a note");
  });

  it("removes a block comment, and nested ones as Postgres does", () => {
    const stripped = stripComments("select /* outer /* inner */ still outer */ 1;");
    expect(stripped).not.toContain("inner");
    expect(stripped).not.toContain("still outer");
    expect(stripped).toContain("select");
  });

  it("leaves a comment marker that is inside a string literal alone", () => {
    const sql = "insert into t (note) values ('two hyphens -- are not a comment');";
    expect(stripComments(sql)).toContain("two hyphens -- are not a comment");
  });

  it("leaves a doubled quote inside a string alone", () => {
    const sql = "insert into t (note) values ('it''s fine -- really');";
    expect(stripComments(sql)).toContain("it''s fine -- really");
  });

  it("leaves a comment marker inside a dollar-quoted body alone", () => {
    const sql = "create function f() returns int language plpgsql as $$ begin -- keep me\n return 1; end $$;";
    expect(stripComments(sql)).toContain("-- keep me");
  });

  it("leaves a comment marker inside a double-quoted identifier alone", () => {
    expect(stripComments('select "odd -- name" from t;')).toContain('"odd -- name"');
  });

  it("does not glue two tokens together where a comment was", () => {
    expect(stripComments("create/**/table t (a int);")).toContain("create table");
  });

  /**
   * The positive control this story exists for, and it is shaped like the FAILURE rather than
   * like the document: `0015`'s header quotes the platform default it was written to REVOKE, in
   * full, as prose. Parsed without stripping, that line becomes an expectation that `anon` holds
   * everything — the exact opposite of what the file asserts — and the command would report a
   * correct project broken.
   *
   * Asserted against the real file rather than a fixture, because a fixture would only prove the
   * stripper works on prose somebody wrote for the test (cairn:
   * a-guard-preprocesses-its-evidence-before-it-looks-2026-08-25 — a control shaped like the
   * document proves the document is not empty and nothing else).
   */
  it("keeps the SQL a migration header QUOTES out of the parse", async () => {
    const sql = await readFile(join(MIGRATIONS, "0015_anon_revoke.sql"), "utf8");
    expect(sql).toContain("grant all on tables    to postgres, anon, authenticated, service_role");

    const stripped = stripComments(sql);
    expect(stripped).not.toContain("grant all on tables");
    expect(stripped).toContain("revoke all on all tables in schema public from anon");

    const parsed = parseMigration({ file: "0015_anon_revoke.sql", sql });
    const grantsToAnon = parsed.statements
      .flatMap((s) => s.ops as Op[])
      .filter((op) => op.role === "anon" && String(op.op).startsWith("grant"));
    expect(grantsToAnon).toEqual([]);

    // The assertion above CANNOT FAIL on its own, and the mutation pass is what showed it: the SQL
    // this header quotes is an `alter default privileges … grant`, which the parser classifies as
    // observable-by-nothing whether it arrives as prose or as code — so removing the stripper
    // entirely left it green (prove-a-guard-test-can-fail, ninth outcome: a second mechanism
    // giving the same answer on the chosen fixture).
    //
    // This one can. The file's first line is a comment by construction, and a header only reaches
    // a parsed statement if it was never stripped. Derived from the file rather than quoted, so
    // rewording the header cannot silently retire it.
    const firstLine = sql.split("\n")[0];
    expect(firstLine.startsWith("--"), firstLine).toBe(true);
    const headerPhrase = firstLine.replace(/^--\s*/, "").slice(0, 40);
    expect(headerPhrase.length).toBeGreaterThan(20);
    for (const statement of parsed.statements) {
      expect(statement.text, statement.text.slice(0, 120)).not.toContain(headerPhrase);
    }
  });

  /**
   * Two independently written scanners, held to one another on the real corpus.
   *
   * This is not a conformance check between copies: `splitStatements` answers *where does a
   * statement end* and `stripComments` answers *what is prose*, and they only agree if both read
   * strings, dollar-quoted bodies and nested block comments the same way. Stripping cannot change
   * how many statements a file has, and a fifteen-file corpus full of plpgsql bodies is a real
   * test of that.
   */
  it("does not change how many statements a migration has", async () => {
    for (const { file, sql } of await corpus()) {
      expect(splitStatements(stripComments(sql)).length, file).toBe(splitStatements(sql).length);
    }
  });
});

// -------------------------------------------------------------------------------------------
// The parser, one named test per artefact kind — AC 7's mutation targets
// -------------------------------------------------------------------------------------------

/**
 * An operation as the parser emits it. The core is plain `.mjs`, so TypeScript infers its return
 * type as a union of every object literal in the function; naming the shape here keeps these
 * assertions about behaviour rather than about which branch the inference happened to widen to.
 */
type Op = Record<string, unknown> & { op: string };

const ops = (sql: string): Op[] => parseStatement(sql).ops as Op[];

describe("parseStatement recognises", () => {
  it("a create table", () => {
    expect(ops("create table public.club (id uuid primary key)")).toEqual([{ op: "table", table: "public.club" }]);
  });

  it("a create function, by name and argument count", () => {
    expect(ops("create function public.owns_boat(boat_id uuid) returns boolean language sql as $$ select true $$")).toEqual([
      { op: "function", fn: "public.owns_boat", nargs: 1 },
    ]);
    expect(ops("create or replace function public.is_admin() returns boolean language sql as $$ select true $$")).toEqual([
      { op: "function", fn: "public.is_admin", nargs: 0 },
    ]);
  });

  it("a create index", () => {
    expect(ops("create index push_subscription_person on public.push_subscription (person_id)")).toEqual([
      { op: "index", index: "public.push_subscription_person" },
    ]);
  });

  it("a create trigger, with the table it is on", () => {
    expect(ops("create trigger post_rung_monotone before update of current_rung on public.post for each row execute function public.f()")).toEqual([
      { op: "trigger", name: "post_rung_monotone", table: "public.post" },
    ]);
  });

  it("a create policy and a drop policy, as opposite expectations", () => {
    expect(ops("create policy club_read on public.club for select to authenticated using (true)")).toEqual([
      { op: "policy", name: "club_read", table: "public.club", present: true },
    ]);
    expect(ops("drop policy club_read on public.club")).toEqual([
      { op: "policy", name: "club_read", table: "public.club", present: false },
    ]);
  });

  it("row level security being enabled", () => {
    expect(ops("alter table public.club enable row level security")).toEqual([{ op: "rls", table: "public.club" }]);
  });

  it("an added column", () => {
    expect(ops("alter table public.club add column admin_email text")).toEqual([
      { op: "column", table: "public.club", column: "admin_email" },
    ]);
  });

  it("several added columns in one statement", () => {
    expect(
      ops("alter table public.person add column rating smallint, add column any_hull boolean not null default true").map(
        (o) => o.column,
      ),
    ).toEqual(["rating", "any_hull"]);
  });

  it("a check constraint, and the literals that tell one version of it from another", () => {
    expect(
      ops("alter table public.person drop constraint person_rating_check, add constraint person_rating_check check (rating in (1, 2, 3, 4))"),
    ).toEqual([
      { op: "constraint", table: "public.person", name: "person_rating_check", present: false },
      { op: "constraint", table: "public.person", name: "person_rating_check", present: true, literals: ["1", "2", "3", "4"] },
    ]);
  });

  it("a table grant", () => {
    expect(ops("grant select on public.answer to service_role")).toEqual([
      { op: "grant-table", role: "service_role", table: "public.answer", privileges: ["SELECT"] },
    ]);
  });

  it("a grant naming several tables at once", () => {
    expect(ops("grant select on public.post, public.boat to service_role").map((o) => o.table)).toEqual([
      "public.post",
      "public.boat",
    ]);
  });

  it("a column grant, one expectation per column", () => {
    expect(ops("grant select (id, name) on public.club to authenticated")).toEqual([
      { op: "grant-column", role: "authenticated", table: "public.club", column: "id", privilege: "SELECT" },
      { op: "grant-column", role: "authenticated", table: "public.club", column: "name", privilege: "SELECT" },
    ]);
  });

  it("a function grant", () => {
    expect(ops("grant execute on function public.is_admin() to authenticated")).toEqual([
      { op: "grant-function", role: "authenticated", fn: "public.is_admin", nargs: 0 },
    ]);
  });

  it("a table revoke", () => {
    expect(ops("revoke all on public.club from anon, authenticated")).toEqual([
      { op: "revoke-table", role: "anon", table: "public.club", privileges: "ALL" },
      { op: "revoke-table", role: "authenticated", table: "public.club", privileges: "ALL" },
    ]);
  });

  it("a function revoke", () => {
    expect(ops("revoke all on function public.is_admin() from public, anon")).toEqual([
      { op: "revoke-function", role: "public", fn: "public.is_admin", nargs: 0, privileges: "ALL" },
      { op: "revoke-function", role: "anon", fn: "public.is_admin", nargs: 0, privileges: "ALL" },
    ]);
  });

  it("a whole-schema revoke", () => {
    expect(ops("revoke all on all tables in schema public from anon")).toEqual([
      { op: "revoke-all-in-schema", role: "anon", objects: "tables", schema: "public" },
    ]);
  });

  it("a default-privilege revoke", () => {
    expect(ops("alter default privileges in schema public revoke all on tables from anon")).toEqual([
      { op: "default-privileges", schema: "public", objects: "tables", role: "anon" },
    ]);
  });
});

describe("parseStatement classifies as observable-by-nothing", () => {
  it("a data backfill", () => {
    const { ops: none, note } = parseStatement("update public.person set rating = 4 where rating = 3");
    expect(none).toEqual([]);
    expect(note).toMatch(/no-op on a project with no matching rows/);
  });

  it("a seed insert", () => {
    const { ops: none, note } = parseStatement("insert into public.boat_class (name) values ('Flying Scot')");
    expect(none).toEqual([]);
    expect(note).toMatch(/seed rows/);
  });
});

describe("the parser refuses to guess", () => {
  /**
   * An unrecognised statement must produce NEITHER an operation NOR a note, because `runVerify`
   * refuses the whole run on one — and that is the point. Silently skipping a statement it does
   * not understand is how this command would report a migration verified while checking none of
   * the thing that migration actually does.
   */
  it("leaves a statement it does not understand unclassified", () => {
    expect(parseStatement("create materialized view public.thing as select 1")).toEqual({ ops: [], note: null });
  });

  /**
   * An `alter table` is a LIST of clauses, and one clause it cannot read makes the whole statement
   * unreadable — returning the clauses it did understand would be worse than returning nothing,
   * because a half-read statement counts as classified and the corpus guard then stays green over
   * a claim nobody is checking.
   *
   * Nothing in `supabase/migrations/` carries such a clause today, so this fixture is the only
   * thing that exercises the refusal. Without it the branch reddens no mutation and is
   * indistinguishable from dead code.
   */
  it("refuses a whole alter table when one of its clauses is a kind it cannot read", () => {
    expect(parseStatement("alter table public.t add column a int, alter column b set default 1")).toEqual({
      ops: [],
      note: null,
    });
    // The control: the same statement without the unreadable clause IS read, so the refusal above
    // is about that clause and not about `alter table` in general.
    expect(ops("alter table public.t add column a int")).toEqual([
      { op: "column", table: "public.t", column: "a" },
    ]);
  });

  /**
   * Postgres folds an unquoted name to lower case and leaves a quoted one alone, so `"Weird"` and
   * `weird` are different objects. Folding them together would generate a read about a table that
   * does not exist and report it MISSING — a false alarm from a correct project, which is the
   * failure that trains people to stop reading the output.
   */
  it("refuses a quoted identifier rather than folding its case", () => {
    expect(() => parseStatement('create table public."Weird" (a int)')).toThrow(/quoted identifiers/);
  });

  it("reports an unreadable statement as a named refusal rather than a stack trace", () => {
    const parsed = parseMigration({ file: "0001.sql", sql: 'create table public."Weird" (a int);' });
    expect(parsed.statements[0].ops).toEqual([]);
    expect(parsed.statements[0].note).toBeNull();
    expect(parsed.statements[0].error).toMatch(/quoted identifiers/);
  });
});

describe("integerLiterals", () => {
  it("reads the values a check expression compares against", () => {
    expect(integerLiterals("rating in (1, 2, 3, 4)")).toEqual(["1", "2", "3", "4"]);
  });

  /**
   * The boundary that stops `4` being found inside `14`, and stops a column called `col2`
   * contributing a `2` (cairn: a-substring-match-is-satisfied-by-a-longer-neighbour-2026-08-25).
   */
  it("takes whole numbers only, never a digit inside a longer token", () => {
    expect(integerLiterals("rung in (14, 20)")).toEqual(["14", "20"]);
    expect(integerLiterals("col2 > 0")).toEqual(["0"]);
  });
});

describe("splitTopLevel", () => {
  it("splits objects but not a column list", () => {
    expect(splitTopLevel("select (id, name), update (phone)")).toEqual(["select (id, name)", "update (phone)"]);
    expect(splitTopLevel("public.post, public.boat")).toEqual(["public.post", "public.boat"]);
  });
});

// -------------------------------------------------------------------------------------------
// Folding — a later file can undo an earlier one
// -------------------------------------------------------------------------------------------

const fold = (files: { file: string; sql: string }[]) => foldExpectations(files.map(parseMigration));

describe("foldExpectations", () => {
  it("lets a later file supersede an earlier one", () => {
    const folded = fold([
      { file: "0001.sql", sql: "create policy p on public.t for select to authenticated using (true);" },
      { file: "0002.sql", sql: "drop policy p on public.t;" },
    ]);
    const policy = folded.facts.find((f) => f.kind === "policy");
    expect(policy?.present).toBe(false);
    expect(policy?.file).toBe("0002.sql");
    expect(folded.superseded.map((s) => s.supersededBy)).toEqual(["0002.sql"]);
  });

  /**
   * The distinction that decides what may be claimed. After a `revoke all` the set a role holds is
   * KNOWN, so what it holds afterwards can be asserted as an equality — which catches a privilege
   * nobody granted as well as one nobody applied. With no such baseline only a lower bound is
   * known, because Supabase grants every new object to all four roles by platform default.
   */
  it("asserts an exact privilege set only where a revoke established a baseline", () => {
    const withBaseline = fold([
      {
        file: "0001.sql",
        sql: "create table public.t (a int); revoke all on public.t from authenticated; grant delete on public.t to authenticated;",
      },
    ]);
    const exact = withBaseline.facts.find((f) => f.kind === "table-acl");
    expect(exact?.expected).toEqual(["DELETE"]);
    expect(withBaseline.facts.find((f) => f.kind === "table-privilege")).toBeUndefined();

    const withoutBaseline = fold([
      { file: "0001.sql", sql: "create table public.t (a int); grant delete on public.t to authenticated;" },
    ]);
    expect(withoutBaseline.facts.find((f) => f.kind === "table-acl")).toBeUndefined();
    expect(withoutBaseline.facts.find((f) => f.kind === "table-privilege")).toMatchObject({
      privilege: "DELETE",
      expected: true,
    });
  });

  it("expands a whole-schema revoke over the objects the files create", () => {
    const folded = fold([
      { file: "0001.sql", sql: "create table public.a (x int); create table public.b (x int);" },
      { file: "0002.sql", sql: "revoke all on all tables in schema public from anon;" },
    ]);
    const swept = folded.facts.filter((f) => f.kind === "table-acl" && f.role === "anon");
    expect(swept.map((f) => f.table).sort()).toEqual(["public.a", "public.b"]);
    expect(swept.every((f) => f.expected.length === 0)).toBe(true);
  });

  it("says so rather than passing vacuously when a sweep has nothing to sweep", () => {
    const folded = fold([{ file: "0001.sql", sql: "revoke all on all sequences in schema public from anon;" }]);
    expect(folded.facts).toEqual([]);
    expect(folded.unobservable[0].note).toMatch(/no sequence in public is created by these files/);
  });

  it("reads the whole corpus with no statement left unclassified", async () => {
    const folded = fold(await corpus());
    expect(folded.unrecognised).toEqual([]);
    expect(folded.facts.length).toBeGreaterThan(100);
  });

  /**
   * #118 — that the premise of `alter default privileges` is ASSERTED at all.
   *
   * The catalog reads below prove this expectation can produce both answers. Nothing there would
   * notice it ceasing to be EMITTED: a fold that quietly dropped it leaves every other expectation
   * holding and the corpus test green on a smaller number, which is the shape cairn calls
   * a-guard-can-be-correct-and-still-not-be-invoked. So the emission is asserted here, on the real
   * corpus, with the object classes checked against the statements that produced them rather than
   * against a list — `0015` names all three, and a file naming only one must yield only that one.
   */
  it("asserts the premise of every alter default privileges, over the classes those statements name", async () => {
    const folded = fold(await corpus());
    const premise = folded.facts.filter((f) => f.kind === "schema-owner");
    expect(premise).toHaveLength(1);
    expect(premise[0].schema).toBe("public");
    expect(premise[0].objects).toEqual(["functions", "sequences", "tables"]);
    expect(premise[0].reference).toBe("public.club");

    const narrower = fold([
      {
        file: "0001.sql",
        sql: "create table public.t (a int); alter default privileges in schema public revoke all on tables from anon;",
      },
    ]);
    const one = narrower.facts.filter((f) => f.kind === "schema-owner");
    expect(one).toHaveLength(1);
    expect(one[0].objects).toEqual(["tables"]);

    // And no such statement means no such premise — an expectation asserted on a corpus that never
    // scopes a default privilege would be one no migration owns, which #118's own notes rule out.
    const none = fold([{ file: "0001.sql", sql: "create table public.t (a int);" }]);
    expect(none.facts.filter((f) => f.kind === "schema-owner")).toEqual([]);
  });

  /**
   * AC 2 — the expectations are DERIVED, not listed.
   *
   * Asserting that directly is awkward: a grep of the command's source for this schema's table
   * names hits only prose (every occurrence is an illustrative example in a docstring), and a
   * check that stripped JavaScript comments before grepping would be a new unproven guard doing
   * the exact thing this command's own header warns about.
   *
   * So it is asserted by RENAMING the subject instead. Every object in a copy of the corpus is
   * moved to a `zz_` prefix; the same number of expectations must come out, and every one about a
   * table or a function must now name the renamed object. A hard-coded expectation survives a
   * rename — that is what makes it hard-coded — so it would show up here as a count that did not
   * move with the corpus, or as a subject still naming the original.
   */
  it("derives its expectations from the files, so renaming every object renames every expectation", async () => {
    const real = fold(await corpus());
    const renamed = fold((await corpus()).map(({ file, sql }) => ({ file, sql: sql.split("public.").join("public.zz_") })));

    expect(renamed.unrecognised).toEqual([]);
    expect(renamed.facts.length).toBe(real.facts.length);

    const named = renamed.facts.filter((f) => f.table || f.fn);
    expect(named.length).toBeGreaterThan(100);
    for (const fact of named) {
      expect(String(fact.table ?? fact.fn), fact.key).toMatch(/^public\.zz_/);
    }

    // The control: the real corpus does NOT produce zz_ subjects, so the assertion above is about
    // the rename rather than about a pattern that would match anything.
    expect(real.facts.filter((f) => String(f.table ?? f.fn).startsWith("public.zz_"))).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// The generated SQL — AC 4
// -------------------------------------------------------------------------------------------

describe("the generated catalog reads", () => {
  /**
   * AC 4. `information_schema` views are FILTERED to what the current role can see, and the token
   * this command uses connects as `supabase_read_only_user` — neither grantor nor grantee of
   * anything these migrations grant. So those views come back EMPTY, which reads as *no grants
   * held* rather than as *you cannot see the grants*, and the check passes identically on a
   * project where every column grant has been lost (cairn:
   * supabase-management-api-tokens-2026-08-31).
   */
  it("never read information_schema", async () => {
    const folded = fold(await corpus());
    const everything = [rolesQuery(folded.roles), controlsQuery(), ...expectationQueries(folded.facts)].join("\n");
    expect(everything).not.toMatch(/information_schema/i);
    expect(everything).toMatch(/pg_catalog|pg_class|pg_proc|pg_policy|pg_trigger|pg_constraint|pg_default_acl/);
    expect(everything).toMatch(/has_table_privilege|has_column_privilege|has_function_privilege/);
  });

  it("guards every privilege read with the existence of the object it is about", async () => {
    // `has_table_privilege` on a missing relation RAISES rather than returning false, and one
    // raise takes a whole batch down — turning "this migration was never applied" into "the query
    // is broken", which is the most misleading outcome available.
    const folded = fold(await corpus());
    for (const fact of folded.facts.filter((f) => f.kind === "table-privilege")) {
      expect(factSql(fact).ok).toMatch(/to_regclass\(.+?\) is null then null/);
    }
    for (const fact of folded.facts.filter((f) => f.kind === "column-privilege")) {
      expect(factSql(fact).ok).toMatch(/then null/);
    }
  });

  it("pairs its controls so each reader must demonstrate BOTH answers", () => {
    expect(CONTROLS.filter((c) => c.expect === true).length).toBeGreaterThan(0);
    expect(CONTROLS.filter((c) => c.expect === false).length).toBeGreaterThan(0);
    // A grant known to exist, read back as true — the criterion AC 4 names.
    expect(CONTROLS.find((c) => c.key === "control:privilege-held")?.sql).toMatch(/has_function_privilege/);
  });
});

// -------------------------------------------------------------------------------------------
// The report — AC 6
// -------------------------------------------------------------------------------------------

describe("the report", () => {
  const facts = [
    { key: "a", file: "0001.sql", kind: "table", subject: "table public.a" },
    { key: "b", file: "0001.sql", kind: "table", subject: "table public.b" },
  ];

  it("counts what holds and what does not, per file", () => {
    const out = report({
      files: ["0001.sql"],
      facts,
      results: [
        { key: "a", ok: true, detail: null },
        { key: "b", ok: false, detail: null },
      ],
      superseded: [],
      unobservable: [],
    });
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain("FAIL  0001.sql");
    expect(out.lines.join("\n")).toContain(`${MISSING}  table public.b`);
  });

  it("calls an unreadable expectation indeterminate rather than present", () => {
    const out = report({
      files: ["0001.sql"],
      facts,
      results: [
        { key: "a", ok: true, detail: null },
        { key: "b", ok: null, detail: null },
      ],
      superseded: [],
      unobservable: [],
    });
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain(INDETERMINATE);
  });

  /**
   * AC 6, and it is an assertion about what the output must NOT say. A clean run reporting
   * "15 of 15 files verified" would be read as "every migration has been applied", which a catalog
   * read cannot establish: a revoke of a privilege nobody held and an update matching no rows both
   * leave the database in the asserted state without the file ever running.
   */
  it("does not claim a migration was applied, on a run where everything holds", () => {
    const out = report({
      files: ["0001.sql"],
      facts,
      results: [
        { key: "a", ok: true, detail: null },
        { key: "b", ok: true, detail: null },
      ],
      superseded: [],
      unobservable: [{ file: "0001.sql", statement: "update ...", note: "data backfill" }],
    });
    expect(out.code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("2 of 2 hold");
    expect(text).toContain("1 statement nothing can testify to");
    expect(text).toContain(SUMMARY_FOOTER.find((l) => l.startsWith("What it does not mean")) as string);

    // Asserted over the FINDINGS only, never over the whole output. The footer's whole job is to
    // say "has not been applied", so a search of the rendered text for that word is satisfied by
    // the disclaimer — the assertion would fail on a correct report and pass on one that dropped
    // the disclaimer, which is backwards in both directions.
    const findings = out.lines.slice(0, out.lines.indexOf(SUMMARY_FOOTER[1]));
    expect(findings.join("\n")).not.toMatch(/\bapplied\b|\bverified\b/i);
  });
});

// -------------------------------------------------------------------------------------------
// The run refuses before it reports — the controls are not decoration
// -------------------------------------------------------------------------------------------

describe("runVerify refuses", () => {
  const migrations = [{ file: "0001.sql", sql: "create table public.t (a int);" }];

  const answering = (rows: (sql: string) => Record<string, unknown>[]) => async (sql: string) => ({
    ok: true,
    rows: rows(sql),
    error: null,
  });

  it("when a role the migrations name does not exist", async () => {
    const out = await runVerify({
      migrations: [{ file: "0001.sql", sql: "create table public.t (a int); grant select on public.t to authenticated;" }],
      runSql: answering((sql) => (sql.includes("pg_roles") ? [{ key: "authenticated", ok: false }] : [])),
    });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("do not exist on this project");
  });

  it("when a control cannot produce the answer it exists to produce", async () => {
    const out = await runVerify({
      migrations,
      runSql: answering((sql) =>
        sql.includes("pg_roles")
          ? []
          : // Every control answers true — including the two that must be able to answer false.
            CONTROLS.map((c) => ({ key: c.key, ok: true })),
      ),
    });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("control:object-absent");
    expect(out.lines.join("\n")).toContain("Nothing was reported");
  });

  it("when a batch comes back with fewer rows than it asked about", async () => {
    const out = await runVerify({
      migrations,
      runSql: answering((sql) => {
        if (sql.includes("pg_roles")) return [];
        if (sql.includes("control:")) return CONTROLS.map((c) => ({ key: c.key, ok: c.expect }));
        return [];
      }),
    });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("no row at all");
  });

  it("when a statement in the migrations is one it cannot classify", async () => {
    const out = await runVerify({
      migrations: [{ file: "0001.sql", sql: "create materialized view public.v as select 1;" }],
      runSql: answering(() => []),
    });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("cannot classify every statement");
  });

  it("when the query itself fails, rather than reading the absent answer as a clean one", async () => {
    const out = await runVerify({
      migrations,
      runSql: async () => ({ ok: false, rows: [], error: "the request never completed" }),
    });
    expect(out.code).toBe(2);
    expect(out.lines.join("\n")).toContain("could not read the role list");
  });
});

// -------------------------------------------------------------------------------------------
// AC 5 — every query goes read-only, asserted on the wire
// -------------------------------------------------------------------------------------------

describe("the transport", () => {
  it("sends read_only: true on every query", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 201, text: async () => "[]" } as unknown as Response;
    };
    const runSql = makeRunSql({ ref: "abc", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    await runSql("select 1");
    await runSql("select 2");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => b.read_only === true)).toBe(true);
  });

  /**
   * Read-only is asked of the PLATFORM rather than left to the SQL happening to be a `select`.
   * Omitted, a write-capable token connects as `postgres` with the transaction open for writing
   * (*measured 2026-08-31*), so a command that says nothing inspects production over a fully
   * writable connection.
   */
  it("passes the flag explicitly rather than relying on the default", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "verify-migrations.mjs"), "utf8");
    expect(source).toMatch(/readOnly:\s*true/);
    expect(source).not.toMatch(/readOnly:\s*false/);
  });
});

// -------------------------------------------------------------------------------------------
// End to end against a real Postgres — AC 1 and AC 4's positive control
// -------------------------------------------------------------------------------------------

describe("against the pglite harness", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  const runSql = async (sql: string) => {
    try {
      const result = await db.query(sql);
      return { ok: true, rows: result.rows as Record<string, unknown>[], error: null };
    } catch (error) {
      return { ok: false, rows: [], error: String(error) };
    }
  };

  it("reports every expectation of every migration as holding", async () => {
    const out = await runVerify({ migrations: await corpus(), runSql });
    // Counted rather than searched for in the rendered text. The report's footer contains the
    // word MISSING by design — it is the sentence explaining what a MISSING line means — so a
    // substring test over the output can never pass, and reads as a broken checker rather than as
    // a broken assertion (cairn: a-substring-match-is-satisfied-by-a-longer-neighbour-2026-08-25,
    // from the other side). The whole report rides on the assertion message instead, because a
    // bare count says nothing about which read went wrong.
    const shown = out.lines.join("\n");
    expect(out.missing, shown).toBe(0);
    expect(out.indeterminate, shown).toBe(0);
    expect(out.code).toBe(0);
    expect(out.holds).toBeGreaterThan(100);
  });

  /**
   * AC 4's own words: a grant that is KNOWN to exist, read back through the generated SQL.
   *
   * `authenticated` holds SELECT on `club.name` by a column grant in `0002`, and holds no
   * table-level SELECT there — `0002` revokes it — so this reading can only come from
   * `has_column_privilege` seeing the column grant. It is paired with a question of the same shape
   * whose answer is known to be NO, because a reader stuck on `true` would pass the first alone.
   */
  it("reads a grant that exists as held, and one that does not as missing", async () => {
    const held = {
      key: "probe:held",
      kind: "column-privilege",
      role: "authenticated",
      table: "public.club",
      column: "name",
      privilege: "SELECT",
      expected: true,
      file: "probe",
      subject: "authenticated holds SELECT on public.club.name",
    };
    const notHeld = { ...held, key: "probe:not-held", role: "anon", subject: "anon holds SELECT on public.club.name" };

    const [sql] = expectationQueries([held, notHeld]);
    const answer = await runSql(sql);
    expect(answer.ok, answer.error ?? "").toBe(true);

    const rows = Object.fromEntries(answer.rows.map((r) => [r.key, r.ok]));
    expect(rows["probe:held"]).toBe(true);
    expect(rows["probe:not-held"]).toBe(false);
  });

  /**
   * #118 — the premise reading, proven able to say NO in each of the three ways it can.
   *
   * The healthy answer here is an absence, which is the position a check quietly stops doing
   * anything from. So nothing below asserts only that a clean schema passes: each arm CREATES the
   * condition the reading exists to catch and requires the answer to move.
   *
   *   a table owned by another role      — the tables half of the population
   *   a function owned by another role   — the functions half, which no table probe can reach
   *   a schema with none of them         — the count clause, whose absence turns "nothing has the
   *                                        wrong owner" into a true statement about nothing
   *
   * The probes are created and dropped inside a `finally`. A leak is loud rather than silent: the
   * whole-corpus test in this block shares this database and would fail on the next run.
   */
  it("reads the alter-default-privileges premise as held, and as broken by a foreign-owned object", async () => {
    const premise = {
      key: "probe:premise",
      kind: "schema-owner",
      schema: "public",
      objects: ["functions", "sequences", "tables"],
      reference: "public.club",
      file: "probe",
      subject: "every object in public is owned by the role that owns public.club",
    };

    const read = async (fact: Record<string, unknown>) => {
      const [sql] = expectationQueries([fact]);
      const answer = await runSql(sql);
      expect(answer.ok, answer.error ?? "").toBe(true);
      return answer.rows[0];
    };

    // Clean, and NOT vacuously: the detail carries the size of the population that was read, so a
    // reading of true over nothing cannot be mistaken for this one.
    const clean = await read(premise);
    expect(clean.ok).toBe(true);
    expect(String(clean.detail)).toMatch(/^\d+ objects, owned by: postgres$/);
    expect(Number(String(clean.detail).split(" ")[0])).toBeGreaterThan(10);

    try {
      await db.exec(`create table public.__owner_probe (a int); alter table public.__owner_probe owner to anon;`);
      const withTable = await read(premise);
      expect(withTable.ok).toBe(false);
      expect(String(withTable.detail)).toContain("anon");
    } finally {
      await db.exec(`drop table if exists public.__owner_probe;`);
    }
    expect((await read(premise)).ok).toBe(true);

    try {
      await db.exec(
        `create function public.__owner_probe_fn() returns int language sql as $$ select 1 $$;
         alter function public.__owner_probe_fn() owner to anon;`,
      );
      const withFunction = await read(premise);
      expect(withFunction.ok).toBe(false);
      expect(String(withFunction.detail)).toContain("anon");
    } finally {
      await db.exec(`drop function if exists public.__owner_probe_fn();`);
    }
    expect((await read(premise)).ok).toBe(true);

    try {
      await db.exec(`create schema __owner_probe_empty;`);
      const empty = await read({ ...premise, key: "probe:premise-empty", schema: "__owner_probe_empty" });
      expect(empty.ok).toBe(false);
      expect(String(empty.detail)).toMatch(/^0 objects/);
    } finally {
      await db.exec(`drop schema if exists __owner_probe_empty cascade;`);
    }
  });

  it("reads a table-level privilege the migrations revoked as absent, and its neighbour as present", async () => {
    const facts = [
      {
        key: "probe:acl-anon",
        kind: "table-acl",
        role: "anon",
        table: "public.club",
        expected: [],
        file: "probe",
        subject: "anon holds no table-level privilege on public.club",
      },
      {
        key: "probe:acl-wrong",
        kind: "table-acl",
        role: "anon",
        table: "public.club",
        expected: ["SELECT"],
        file: "probe",
        subject: "anon holds exactly SELECT on public.club",
      },
    ];
    const [sql] = expectationQueries(facts);
    const answer = await runSql(sql);
    expect(answer.ok, answer.error ?? "").toBe(true);
    const rows = Object.fromEntries(answer.rows.map((r) => [r.key, r.ok]));
    expect(rows["probe:acl-anon"]).toBe(true);
    expect(rows["probe:acl-wrong"]).toBe(false);
  });

  /**
   * The constraint reading is the one `check:live` structurally cannot make, and existence alone
   * cannot make either: `0011` drops `person_rating_check` and adds a constraint of the SAME NAME
   * with a fourth level in it. What distinguishes the two is the set of literals, which is what is
   * compared — so this asserts the applied version reads as holding and the superseded one does
   * not.
   */
  it("tells a re-pointed check constraint from the one it replaced", async () => {
    const base = {
      kind: "constraint",
      table: "public.person",
      name: "person_rating_check",
      present: true,
      file: "probe",
      subject: "constraint person_rating_check on public.person",
    };
    const facts = [
      { ...base, key: "probe:four", literals: ["1", "2", "3", "4"] },
      { ...base, key: "probe:five", literals: ["1", "2", "3", "4", "5"] },
    ];
    const [sql] = expectationQueries(facts);
    const answer = await runSql(sql);
    expect(answer.ok, answer.error ?? "").toBe(true);
    const rows = Object.fromEntries(answer.rows.map((r) => [r.key, r.ok]));
    expect(rows["probe:four"]).toBe(true);
    expect(rows["probe:five"]).toBe(false);
  });

  it("reads an expectation about a missing object as indeterminate rather than raising", async () => {
    const fact = {
      key: "probe:absent",
      kind: "table-privilege",
      role: "authenticated",
      table: "public.__not_a_table",
      privilege: "SELECT",
      expected: true,
      file: "probe",
      subject: "authenticated holds SELECT on public.__not_a_table",
    };
    const [sql] = expectationQueries([fact]);
    const answer = await runSql(sql);
    expect(answer.ok, answer.error ?? "").toBe(true);
    expect(answer.rows[0].ok).toBeNull();
    expect(report({ files: ["probe"], facts: [fact], results: answer.rows, superseded: [], unobservable: [] }).code).toBe(1);
  });

  /**
   * The boundary that stops a digit inside an IDENTIFIER being read as a value the constraint
   * compares against. `rung2 = 5` mentions no 2 — the 2 is part of the column's name — so a
   * boundary-less match would find one and report a constraint as holding when it does not.
   *
   * The fixture is built here because no constraint in `supabase/migrations/` names a column with
   * a digit in it, so on the real corpus the two spellings agree on every input and the mutation
   * that drops the boundary reddens nothing at all (*measured*).
   */
  it("does not read a digit inside an identifier as a value a constraint compares against", async () => {
    await db.exec("create table public.__probe_literals (rung2 smallint constraint probe_rung2_check check (rung2 in (5)));");
    try {
      const base = {
        kind: "constraint",
        table: "public.__probe_literals",
        name: "probe_rung2_check",
        present: true,
        file: "probe",
        subject: "constraint probe_rung2_check on public.__probe_literals",
      };
      const [sql] = expectationQueries([
        { ...base, key: "probe:digit-in-name", literals: ["2"] },
        { ...base, key: "probe:real-value", literals: ["5"] },
      ]);
      const answer = await runSql(sql);
      expect(answer.ok, answer.error ?? "").toBe(true);
      const rows = Object.fromEntries(answer.rows.map((r) => [r.key, r.ok]));
      // The positive control: the value the constraint really does compare against reads true, so
      // a false above is the boundary working rather than the whole reading being broken.
      expect(rows["probe:real-value"]).toBe(true);
      expect(rows["probe:digit-in-name"]).toBe(false);
    } finally {
      await db.exec("drop table public.__probe_literals;");
    }
  });

  it("passes all four controls against a real catalog", async () => {
    const answer = await runSql(controlsQuery());
    expect(answer.ok, answer.error ?? "").toBe(true);
    for (const control of CONTROLS) {
      expect(answer.rows.find((r) => r.key === control.key)?.ok, control.key).toBe(control.expect);
    }
  });

  it("finds every role the migrations name", async () => {
    const folded = fold(await corpus());
    const answer = await runSql(rolesQuery(folded.roles));
    expect(answer.ok, answer.error ?? "").toBe(true);
    expect(answer.rows.every((r) => r.ok === true)).toBe(true);
  });

  /**
   * The verdict word itself, read off a real catalog row.
   *
   * This asserted `out.missing === 0` over a whole run until the mutation pass reached it, and that
   * CANNOT FAIL: every refusal path returns `missing: 0` too, because nothing was read — so the
   * assertion was satisfied by the run being refused, which is the outcome it was meant to exclude
   * (prove-a-guard-test-can-fail, eighth outcome: ask which case would go red, and treat "none" as
   * the result).
   */
  it("labels a satisfied expectation HOLDS", async () => {
    const fact = {
      key: "probe:verdict",
      kind: "table",
      table: "public.club",
      file: "probe",
      subject: "table public.club",
    };
    const [sql] = expectationQueries([fact]);
    const answer = await runSql(sql);
    expect(answer.ok, answer.error ?? "").toBe(true);
    expect(verdictFor(fact, answer.rows[0]).verdict).toBe(HOLDS);
  });
});
