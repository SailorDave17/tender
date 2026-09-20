import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigration, as, freshDb } from "./pglite";

/**
 * 0024 — the `skill` list and `person.skills` (story #68 AC 1 and AC 2).
 *
 * As in person.test.ts and availability.test.ts, every deny is written against `authenticated`
 * and sits beside a POSITIVE CONTROL on the same mechanism, so a `0` or `[]` read means refused
 * rather than query-wrong. The `anon` side is worth a case of its own here only because the
 * harness reproduces Supabase's default grants (test/pglite.ts, story #48) — without that it
 * would be a case that could not fail; the schema-wide sweep is in test/anon-grants.test.ts.
 *
 * The backfill block is the half no other instrument can see, and it is the same shape #69's
 * renumber needed: the rows have to exist BEFORE the migration runs, which is what
 * `freshDb({ through })` is for. The default harness applies every file before any test can
 * insert a row, so a migration that fills a new column from an old one cannot be tested through
 * it at all.
 *
 * The two databases here boot SEQUENTIALLY, in separate describes, never in one `Promise.all`:
 * parallel boots in one file pushed harness-budget.test.ts past its measured budget on #24.
 */

const ADA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const CAI = "33333333-3333-4333-8333-333333333333";
const DOT = "44444444-4444-4444-8444-444444444444";
const EVE = "55555555-5555-4555-8555-555555555555";

describe("0024 — the skill list, and who may read it", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    await db.exec(`
      insert into auth.users (id) values ('${ADA}'), ('${BEN}');
      insert into public.person (id, display_name, adult_attested_at, rating, any_hull, skills) values
        ('${ADA}', 'Ada', now(), 2, true, '{hike-trim}'),
        ('${BEN}', 'Ben', now(), 4, true, '{helm}');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("seeds the four skills with #69's levels, in sort order", async () => {
    const r = await db.query<{ code: string; label: string; level: number; sort: number }>(
      `select code, label, level, sort from public.skill order by sort`,
    );
    expect(r.rows).toEqual([
      { code: "never-raced", label: "Never raced", level: 1, sort: 1 },
      { code: "hike-trim", label: "Can hike and trim", level: 2, sort: 2 },
      // Spinnaker is its own level BETWEEN trim and helm — the owner's placement, landed by 0011
      // (#69). A seed that put it at 2 beside trim is the first filing of this story, and would
      // make every spinnaker hand indistinguishable from a trimmer to the ladder.
      { code: "spinnaker", label: "Can fly a spinnaker", level: 3, sort: 3 },
      { code: "helm", label: "Can helm", level: 4, sort: 4 },
    ]);
  });

  it("holds level to the four-level scale, refusing 0 and 5", async () => {
    await expect(
      db.exec(`insert into public.skill (code, label, level, sort) values ('x', 'X', 5, 9)`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(`insert into public.skill (code, label, level, sort) values ('x', 'X', 0, 9)`),
    ).rejects.toThrow(/check constraint/);
    // Positive control: the same insert at a legal level goes in, so the two rejections above
    // are the constraint and not the statement.
    await db.exec(`insert into public.skill (code, label, level, sort) values ('x', 'X', 3, 9)`);
    await db.exec(`delete from public.skill where code = 'x'`);
  });

  it("a signed-in person reads the list; anon is refused at the grant", async () => {
    const mine = await as(db, "authenticated", `select code from public.skill order by sort`, ADA);
    expect(mine.rows.map((r) => (r as { code: string }).code)).toEqual([
      "never-raced",
      "hike-trim",
      "spinnaker",
      "helm",
    ]);
    // The read above is the positive control for this one: the same statement, same table, a
    // different role. anon's refusal is a GRANT, not an empty policy.
    //
    // Which grant, precisely — *measured* by mutation, and not the one this file would suggest.
    // Deleting 0024's own `revoke all on public.skill from anon, authenticated` reddens 2 tests
    // and NOT this one, because 0015 carries `alter default privileges … revoke all on tables
    // from anon`: every table created from 0016 on is never granted to anon in the first place,
    // so 0024's anon revoke is a no-op and this assertion is proof about 0015. Two mechanisms,
    // one observable (cairn: prove-a-guard-test-can-fail, the two-guards shape). The AC asks for
    // the outcome, which this does hold; it is the ATTRIBUTION that would have been wrong, and
    // the `authenticated` half of the same revoke is load-bearing — see the test below, which is
    // one of the two that did redden.
    await expect(as(db, "anon", `select code from public.skill`)).rejects.toThrow(
      /permission denied for table skill/,
    );
  });

  it("no client role may write the list — it is seeded by migration, like boat_class", async () => {
    for (const role of ["authenticated", "anon"] as const) {
      await expect(
        as(db, role, `insert into public.skill (code, label, level, sort) values ('foredeck', 'Foredeck', 3, 9)`, ADA),
      ).rejects.toThrow(/permission denied for table skill/);
    }
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.skill`);
    expect(r.rows[0].n).toBe(4);
  });
});

describe("0024 — person.skills is the person's own column and nobody else's (AC 1)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    await db.exec(`
      insert into auth.users (id) values ('${ADA}'), ('${BEN}');
      insert into public.person (id, display_name, adult_attested_at, rating, any_hull, skills) values
        ('${ADA}', 'Ada', now(), 2, true, '{hike-trim}'),
        ('${BEN}', 'Ben', now(), 4, true, '{helm}');
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("defaults to the empty array rather than null, for a person who has said nothing", async () => {
    await db.exec(`insert into auth.users (id) values ('${CAI}');`);
    await db.exec(
      `insert into public.person (id, display_name, adult_attested_at) values ('${CAI}', 'Cai', now());`,
    );
    const r = await db.query<{ skills: string[]; rating: number | null }>(
      `select skills, rating from public.person where id = '${CAI}'`,
    );
    expect(r.rows).toEqual([{ skills: [], rating: null }]);
  });

  it("a person updates their OWN skills, and it persists (the positive control)", async () => {
    const w = await as(
      db,
      "authenticated",
      `update public.person set skills = '{hike-trim,spinnaker}', rating = 3 where id = '${ADA}'`,
      ADA,
    );
    expect(w.affectedRows ?? 0).toBe(1);
    const r = await db.query<{ skills: string[]; rating: number }>(
      `select skills, rating from public.person where id = '${ADA}'`,
    );
    expect(r.rows).toEqual([{ skills: ["hike-trim", "spinnaker"], rating: 3 }]);
  });

  it("a signed-in person cannot write ANOTHER person's skills (zero rows, 0002's policy)", async () => {
    const w = await as(
      db,
      "authenticated",
      `update public.person set skills = '{helm}' where id = '${BEN}'`,
      ADA,
    );
    expect(w.affectedRows ?? 0).toBe(0);
    // Read back: zero rows affected is the policy hiding the row, and the row is untouched. Ben
    // was seeded '{helm}' already, so the assertion is on a value Ada's statement did not write —
    // she wrote the same value, which is exactly the case a row-count alone could not separate.
    const r = await db.query<{ skills: string[]; rating: number }>(
      `select skills, rating from public.person where id = '${BEN}'`,
    );
    expect(r.rows).toEqual([{ skills: ["helm"], rating: 4 }]);
  });

  it("a person still cannot reach is_admin through the same update (the grant, not the policy)", async () => {
    // The column grant is what 0024 adds to, so this is the assertion that it added `skills` and
    // nothing else: one more column would be silent here without it.
    await expect(
      as(
        db,
        "authenticated",
        `update public.person set skills = '{helm}', is_admin = true where id = '${ADA}'`,
        ADA,
      ),
    ).rejects.toThrow(/permission denied for table person/);
  });

  it("every signed-in person reads every person's skills — a skipper must see them", async () => {
    // The whole club, not the caller's own row: the skipper's candidate list is built from this
    // read. `select skills` is the subject — before 0024's select grant it would raise rather
    // than return, which is the direction that matters here.
    const r = await as(
      db,
      "authenticated",
      `select display_name, skills from public.person where id in ('${ADA}', '${BEN}') order by display_name`,
      ADA,
    );
    expect(r.rows).toEqual([
      { display_name: "Ada", skills: ["hike-trim", "spinnaker"] },
      { display_name: "Ben", skills: ["helm"] },
    ]);
  });
});

/**
 * AC 2 — the backfill, tested against rows that existed BEFORE the migration ran.
 *
 * The claim is an equivalence: every person reads the same `rating` afterwards as before. So the
 * fixture is written on the post-0011 four-level scale (0024's header names 0011 as a hard
 * prerequisite), 0024 is applied by hand, and both columns are read back.
 */
describe("0024 backfills skills from the rating that is already there (AC 2)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb({ through: "0023" });
    await db.exec(`
      insert into auth.users (id) values ('${ADA}'), ('${BEN}'), ('${CAI}'), ('${DOT}'), ('${EVE}');
      insert into public.person (id, display_name, adult_attested_at, rating, any_hull) values
        ('${ADA}', 'Ada', now(), 1, true),
        ('${BEN}', 'Ben', now(), 2, true),
        ('${CAI}', 'Cai', now(), 3, true),
        ('${DOT}', 'Dot', now(), 4, true),
        ('${EVE}', 'Eve', now(), null, true);
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stops before 0024, so the fixture is written on a person table with no skills column", async () => {
    // The positive control for the harness option itself: if `through` silently applied
    // everything, the column would already be here and every assertion below would be about a
    // state that was never pre-migration (cairn: an-absent-result-reads-as-a-clean-one).
    const c = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'person' and column_name = 'skills'`,
    );
    expect(c.rows[0].n, "person.skills should not exist yet").toBe(0);

    // `through` is INCLUSIVE of the file it names, and only this pins that: without it the
    // assertion above passes just as well for `through: "0022"`, and every fixture built on this
    // option would sit on the wrong schema with nothing to say so.
    const t = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name = 'suspension'`,
    );
    expect(t.rows[0].n, "0023's own table should be present — through is inclusive").toBe(1);
  });

  it("maps each rating to its one skill and leaves every rating untouched", async () => {
    // The precondition asserted INSIDE the test whose claim rests on it, not only in the sibling
    // above: this block applies 0024 itself, so on an already-migrated database the backfill
    // would run again and the assertions would pass for the wrong reason (measured on #69).
    await expect(
      db.query(`select skills from public.person limit 1`),
    ).rejects.toThrow(/column "skills" does not exist/);

    await applyMigration(db, "0024");

    const r = await db.query<{ display_name: string; rating: number | null; skills: string[] }>(
      `select display_name, rating, skills from public.person order by display_name`,
    );
    expect(r.rows).toEqual([
      { display_name: "Ada", rating: 1, skills: ["never-raced"] },
      { display_name: "Ben", rating: 2, skills: ["hike-trim"] },
      { display_name: "Cai", rating: 3, skills: ["spinnaker"] },
      { display_name: "Dot", rating: 4, skills: ["helm"] },
      // Nobody ticks a box on Eve's behalf: she has not said anything, and inventing
      // `{never-raced}` would turn the board's "set your competence first" banner off for
      // somebody who never set it.
      { display_name: "Eve", rating: null, skills: [] },
    ]);
  });

  it("the code each rating maps to is a real row of skill, at the same level", async () => {
    // The mapping is stated twice — once in the backfill's CASE, once in the seed — and this is
    // what holds the two equal. A backfill that wrote `{spinaker}` would pass the test above,
    // because nothing in Postgres ties a text[] element to a row (no array foreign key).
    const r = await db.query<{ rating: number; level: number }>(
      `select p.rating, s.level
         from public.person p
         join public.skill s on s.code = p.skills[1]
        where p.rating is not null
        order by p.rating`,
    );
    expect(r.rows).toEqual([
      { rating: 1, level: 1 },
      { rating: 2, level: 2 },
      { rating: 3, level: 3 },
      { rating: 4, level: 4 },
    ]);
  });
});
