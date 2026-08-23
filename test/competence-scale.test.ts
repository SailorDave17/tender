import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigration, freshDb } from "./pglite";

/**
 * Story #69 AC 1 and AC 2 — 0011 widens the competence scale to four levels and renumbers the
 * helms it finds, in that order.
 *
 * The renumber is the half no other instrument can see. A row left at 3 does not error: it
 * silently becomes a spinnaker hand, and the person it belongs to goes on being suggested for
 * posts they can no longer crew. So the fixture has to exist BEFORE 0011 runs, which is what
 * `freshDb({ through })` is for — the default harness applies every migration before any test
 * can insert a row, and a story that renumbers data cannot be tested through it at all (the
 * trap #64's AC 2 walked into, recorded in cairn as a-criterion-cannot-price-the-mechanism).
 *
 * Every insert here is `service_role`, because the point is the migration's effect on stored
 * rows, not any policy: a case that had to satisfy RLS as well would confound the two.
 */

const ADA = "11111111-1111-4111-8111-111111111111";
const BO = "22222222-2222-4222-8222-222222222222";

describe("0011 renumbers the rows that existed before it", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb({ through: "0010" });

    // Everything below is written on the OLD scale: 3 is a helm, 2 is a trimmer.
    await db.exec(`
      insert into auth.users (id) values ('${ADA}'), ('${BO}');
      insert into public.person (id, display_name, adult_attested_at, rating, any_hull)
        values ('${ADA}', 'Ada', now(), 3, true), ('${BO}', 'Bo', now(), 2, true);
      insert into public.boat_class (name) values ('Thistle') on conflict do nothing;
      insert into public.race_date (starts_at, title, published)
        values ('2027-05-02T17:00:00Z', 'Spring 1', true);
      insert into public.boat (id, owner_id, name, class, default_minimum)
        values ('33333333-3333-4333-8333-333333333333', '${ADA}', 'Blue Moon', 'Thistle', 3);
      insert into public.post (boat_id, race_date_id, minimum)
        select '33333333-3333-4333-8333-333333333333', id, 3 from public.race_date limit 1;
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("stops before 0011, so the fixture is written on the three-level scale", async () => {
    // The positive control for the harness option itself: if `through` silently applied
    // everything, the check below would already read (1, 2, 3, 4) and every assertion in this
    // file would be about a state that was never pre-migration.
    const r = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'person_rating_check'`,
    );
    expect(r.rows[0].def).toContain("3");
    expect(r.rows[0].def).not.toContain("4");

    // `through` is INCLUSIVE of the migration it names, and only this pins that: without it the
    // assertion above passes just as well for `through: "0009"`, so an off-by-one in the harness
    // would be invisible and every later fixture would be built on the wrong schema.
    const t = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name = 'suggestion'`,
    );
    expect(t.rows[0].n, "0010's own table should be present — through is inclusive").toBe(1);
  });

  it("a helm at 3 becomes 4, and a trimmer at 2 is left alone", async () => {
    // The precondition asserted INSIDE the test whose claim rests on it. Without this the test
    // passes on a database that already had 0011 applied, because it re-applies 0011 itself and
    // the renumber moves 3 -> 4 either way — measured: mutating `through` to a no-op reddened the
    // sibling test only, and this one went on passing for the wrong reason.
    await expect(
      db.exec(`update public.person set rating = 4 where id = '${BO}'`),
    ).rejects.toThrow(/check constraint/);

    await applyMigration(db, "0011");

    const people = await db.query<{ display_name: string; rating: number }>(
      `select display_name, rating from public.person order by display_name`,
    );
    expect(people.rows).toEqual([
      { display_name: "Ada", rating: 4 },
      { display_name: "Bo", rating: 2 },
    ]);

    const boats = await db.query<{ default_minimum: number }>(`select default_minimum from public.boat`);
    expect(boats.rows).toEqual([{ default_minimum: 4 }]);

    const posts = await db.query<{ minimum: number }>(`select minimum from public.post`);
    expect(posts.rows).toEqual([{ minimum: 4 }]);
  });
});

describe("0011 widens exactly the three competence checks", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
  });

  afterAll(async () => {
    await db?.close();
  });

  it("person.rating, boat.default_minimum and post.minimum accept 4", async () => {
    for (const conname of ["person_rating_check", "boat_default_minimum_check", "post_minimum_check"]) {
      const r = await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`,
        [conname],
      );
      expect(r.rows.length, `${conname} should exist`).toBe(1);
      expect(r.rows[0].def, conname).toMatch(/ARRAY\[1, 2, 3, 4\]/);
    }
  });

  it("still refuses 5 and 0 — widened, not opened", async () => {
    await db.exec(`insert into auth.users (id) values ('${ADA}');`);
    await expect(
      db.exec(`insert into public.person (id, display_name, adult_attested_at, rating) values ('${ADA}', 'Ada', now(),5);`),
    ).rejects.toThrow();
    await expect(
      db.exec(`insert into public.person (id, display_name, adult_attested_at, rating) values ('${ADA}', 'Ada', now(),0);`),
    ).rejects.toThrow();
  });

  /**
   * The ladder's rungs are a DIFFERENT scale that happens to share the values 1..3, and a grep
   * for `in (1, 2, 3)` across the migrations returns five checks, not three. This is the guard
   * against the obvious wrong fix — widening all five, which would let a post claim a fourth
   * rung the engine has no name for.
   */
  it("leaves the ladder's own rung checks at three", async () => {
    for (const conname of ["post_current_rung_check", "suggestion_rung_check"]) {
      const r = await db.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`,
        [conname],
      );
      expect(r.rows.length, `${conname} should exist`).toBe(1);
      expect(r.rows[0].def, conname).toMatch(/ARRAY\[1, 2, 3\]/);
      expect(r.rows[0].def, conname).not.toContain("4");
    }
  });
});

describe("freshDb({ through }) refuses a prefix it cannot resolve", () => {
  /**
   * Without this the option's failure mode is the worst kind: an unmatched prefix that falls
   * back to "apply everything" produces a green test asserting a post-migration state while its
   * name says pre-migration (cairn: an-absent-result-reads-as-a-clean-one).
   */
  it("throws on a prefix matching no migration", async () => {
    await expect(freshDb({ through: "9999" })).rejects.toThrow(/matches 0 files/);
  });

  it("throws on a prefix matching more than one", async () => {
    await expect(freshDb({ through: "00" })).rejects.toThrow(/matches \d+ files/);
  });
});
