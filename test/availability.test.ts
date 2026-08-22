import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0005 — person's profile columns, boat_class, availability, and the phone grant on
 * person_contact. Story #18 AC 1: a crew inserting an availability row for another person_id is
 * refused, and a third user can read the row.
 *
 * As in person.test.ts, every deny is against `authenticated` (the harness grants anon nothing
 * Supabase would, so an anon case could not fail; that side is #48's), and every deny sits
 * beside a positive control on the same mechanism so a `0`/`[]` read means refused rather than
 * query-wrong.
 */

const ANN = "11111111-1111-4111-8111-111111111111"; // rated, hull-specific
const BO = "22222222-2222-4222-8222-222222222222"; // rated, any hull
const CY = "33333333-3333-4333-8333-333333333333"; // unrated — just signed in
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ANN}'), ('${BO}'), ('${CY}');
    insert into public.person (id, display_name, adult_attested_at, rating, any_hull, hulls) values
      ('${ANN}', 'Ann', now(), 3, false, '{Thistle}'),
      ('${BO}', 'Bo', now(), 2, true, '{}'),
      ('${CY}', 'Cy', now(), null, true, '{}');
    insert into public.person_contact (person_id, email, phone) values
      ('${ANN}', 'ann@example.org', null),
      ('${BO}', 'bo@example.org', null),
      ('${CY}', 'cy@example.org', null);
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', '2027-04-11T17:00:00Z', 'Spring series 1', true),
      ('${DRAFT}', '2027-04-18T17:00:00Z', 'Spring series 2', false);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("person (0005) — rating, any_hull, hulls at the table", () => {
  it("refuses a rating outside 1..3", async () => {
    await expect(
      db.exec(`update public.person set rating = 4 where id = '${CY}'`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(`update public.person set rating = 0 where id = '${CY}'`),
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses any_hull false with no classes chosen — the state the engine would misread as any", async () => {
    await expect(
      db.exec(`update public.person set any_hull = false, hulls = '{}' where id = '${CY}'`),
    ).rejects.toThrow(/person_hulls_chosen_or_any/);
    // Positive control on the same constraint: false with a class is the intended state.
    await db.exec(`update public.person set any_hull = false, hulls = '{Interlake}' where id = '${CY}'`);
    await db.exec(`update public.person set any_hull = true, hulls = '{}' where id = '${CY}'`);
  });

  it("defaults to any hull with nothing chosen and no rating", async () => {
    const r = await db.query<{ rating: number | null; any_hull: boolean; hulls: string[] }>(
      `select rating, any_hull, hulls from public.person where id = '${CY}'`,
    );
    expect(r.rows).toEqual([{ rating: null, any_hull: true, hulls: [] }]);
  });
});

describe("person (0005) — a crew sets their own profile and nobody else's", () => {
  it("the three columns are readable and writable by authenticated, by column", async () => {
    const r = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'person'
          and column_name in ('rating', 'any_hull', 'hulls')
        order by privilege_type, column_name`,
    );
    expect(r.rows).toEqual([
      { privilege_type: "SELECT", column_name: "any_hull" },
      { privilege_type: "SELECT", column_name: "hulls" },
      { privilege_type: "SELECT", column_name: "rating" },
      { privilege_type: "UPDATE", column_name: "any_hull" },
      { privilege_type: "UPDATE", column_name: "hulls" },
      { privilege_type: "UPDATE", column_name: "rating" },
    ]);
  });

  it("a rated crew updates their own rating and hulls, and it persists", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.person set rating = 2, any_hull = false, hulls = '{Thistle,"Flying Scot"}'
         where id = '${ANN}'`,
      ANN,
    );
    expect(u.affectedRows).toBe(1);
    const r = await db.query<{ rating: number; any_hull: boolean; hulls: string[] }>(
      `select rating, any_hull, hulls from public.person where id = '${ANN}'`,
    );
    expect(r.rows).toEqual([{ rating: 2, any_hull: false, hulls: ["Thistle", "Flying Scot"] }]);
    await db.exec(`update public.person set rating = 3, hulls = '{Thistle}' where id = '${ANN}'`);
  });

  it("another person's rating is zero rows, not an error (policy), and unchanged", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.person set rating = 1 where id = '${ANN}'`,
      BO,
    );
    expect(u.affectedRows ?? 0).toBe(0);
    const r = await db.query<{ rating: number }>(`select rating from public.person where id = '${ANN}'`);
    expect(r.rows).toEqual([{ rating: 3 }]);
  });

  it("every signed-in person reads everyone's rating and hull willingness (a skipper's list needs them)", async () => {
    const r = await as(
      db,
      "authenticated",
      `select display_name, rating, any_hull, hulls from public.person order by display_name`,
      CY,
    );
    expect(r.rows).toEqual([
      { display_name: "Ann", rating: 3, any_hull: false, hulls: ["Thistle"] },
      { display_name: "Bo", rating: 2, any_hull: true, hulls: [] },
      { display_name: "Cy", rating: null, any_hull: true, hulls: [] },
    ]);
  });
});

describe("person_contact (0005) — phone is the one column a person may write", () => {
  it("a person sets their own phone and it persists; the grant is phone only", async () => {
    const grants = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public'
          and table_name = 'person_contact' and privilege_type = 'UPDATE'`,
    );
    expect(grants.rows).toEqual([{ privilege_type: "UPDATE", column_name: "phone" }]);

    const u = await as(
      db,
      "authenticated",
      `update public.person_contact set phone = '614-555-0100' where person_id = '${ANN}'`,
      ANN,
    );
    expect(u.affectedRows).toBe(1);
    const r = await db.query<{ phone: string | null }>(
      `select phone from public.person_contact where person_id = '${ANN}'`,
    );
    expect(r.rows).toEqual([{ phone: "614-555-0100" }]);
  });

  it("email is still refused even on the person's own row (column grant)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `update public.person_contact set email = 'x@example.org' where person_id = '${ANN}'`,
        ANN,
      ),
    ).rejects.toThrow(/permission denied for table person_contact/);
  });

  it("another person's phone is zero rows (policy), and unchanged", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.person_contact set phone = '000' where person_id = '${ANN}'`,
      BO,
    );
    expect(u.affectedRows ?? 0).toBe(0);
    const r = await db.query<{ phone: string | null }>(
      `select phone from public.person_contact where person_id = '${ANN}'`,
    );
    expect(r.rows).toEqual([{ phone: "614-555-0100" }]);
  });

  it("another person's contact row is still unreadable after the grant (0002's policy holds)", async () => {
    const r = await as(
      db,
      "authenticated",
      `select phone from public.person_contact where person_id = '${ANN}'`,
      BO,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("boat_class (0005) — the fleet list", () => {
  it("is seeded with the six HSC classes (owner decision G), readable by every signed-in person", async () => {
    const r = await as(db, "authenticated", `select name from public.boat_class order by name`, CY);
    expect(r.rows.map((x) => (x as { name: string }).name)).toEqual([
      "Flying Scot",
      "Highlander",
      "Interlake",
      "MC Scow",
      "Thistle",
      "Windmill",
    ]);
  });

  it("is written by no client role: insert is refused at the grant", async () => {
    await expect(
      as(db, "authenticated", `insert into public.boat_class (name) values ('Laser')`, ANN),
    ).rejects.toThrow(/permission denied for table boat_class/);
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'boat_class'`,
    );
    expect(t.rows).toEqual([{ privilege_type: "SELECT" }]);
  });
});

describe("availability (0005) — shape", () => {
  it("exists with row level security on and a composite primary key", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.availability'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const pk = await db.query<{ cols: string[] }>(
      `select array_agg(a.attname order by a.attnum) as cols
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'public.availability'::regclass and c.contype = 'p'`,
    );
    expect(pk.rows).toEqual([{ cols: ["person_id", "race_date_id"] }]);
  });

  it("cascades when the person or the race date goes", async () => {
    const r = await db.query<{ confrelid: string; confdeltype: string }>(
      `select confrelid::regclass::text as confrelid, confdeltype from pg_constraint
        where conrelid = 'public.availability'::regclass and contype = 'f' order by confrelid`,
    );
    expect(r.rows).toEqual([
      { confrelid: "person", confdeltype: "c" },
      { confrelid: "race_date", confdeltype: "c" },
    ]);
  });

  it("grants authenticated select and insert by column, delete whole-table, never update", async () => {
    const c = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'availability'
        order by privilege_type, column_name`,
    );
    expect(c.rows).toEqual([
      { privilege_type: "INSERT", column_name: "person_id" },
      { privilege_type: "INSERT", column_name: "race_date_id" },
      { privilege_type: "SELECT", column_name: "created_at" },
      { privilege_type: "SELECT", column_name: "person_id" },
      { privilege_type: "SELECT", column_name: "race_date_id" },
    ]);
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'availability'`,
    );
    expect(t.rows).toEqual([{ privilege_type: "DELETE" }]);
  });
});

describe("availability (0005) — AC 1: self insert and delete, everyone reads", () => {
  it("a rated crew marks themselves available and the row lands", async () => {
    const i = await as(
      db,
      "authenticated",
      `insert into public.availability (person_id, race_date_id) values ('${ANN}', '${SUNDAY}')`,
      ANN,
    );
    expect(i.affectedRows).toBe(1);
  });

  it("a crew inserting a row for another person_id is refused (row-level security), and nothing lands", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.availability (person_id, race_date_id) values ('${ANN}', '${DRAFT}')`,
        BO,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from public.availability where person_id = '${ANN}'`,
    );
    expect(n.rows).toEqual([{ n: 1 }]);
  });

  it("a third user can read the row", async () => {
    const r = await as(
      db,
      "authenticated",
      `select person_id, race_date_id from public.availability`,
      CY,
    );
    expect(r.rows).toEqual([{ person_id: ANN, race_date_id: SUNDAY }]);
  });

  it("an unrated person cannot mark a day (policy) — the board sends them to /profile first", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.availability (person_id, race_date_id) values ('${CY}', '${SUNDAY}')`,
        CY,
      ),
    ).rejects.toThrow(/row-level security policy/);
    // Positive control on the same person: once rated, the same insert lands.
    await db.exec(`update public.person set rating = 1 where id = '${CY}'`);
    const i = await as(
      db,
      "authenticated",
      `insert into public.availability (person_id, race_date_id) values ('${CY}', '${SUNDAY}')`,
      CY,
    );
    expect(i.affectedRows).toBe(1);
    await db.exec(`delete from public.availability where person_id = '${CY}';
                   update public.person set rating = null where id = '${CY}'`);
  });

  it("marking the same day twice is refused by the primary key", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.availability (person_id, race_date_id) values ('${ANN}', '${SUNDAY}')`,
        ANN,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("a crew cannot delete another person's row (zero rows), and can delete their own", async () => {
    const other = await as(
      db,
      "authenticated",
      `delete from public.availability where person_id = '${ANN}'`,
      BO,
    );
    expect(other.affectedRows ?? 0).toBe(0);
    const still = await db.query<{ n: number }>(`select count(*)::int as n from public.availability`);
    expect(still.rows).toEqual([{ n: 1 }]);

    const own = await as(
      db,
      "authenticated",
      `delete from public.availability where person_id = '${ANN}' and race_date_id = '${SUNDAY}'`,
      ANN,
    );
    expect(own.affectedRows).toBe(1);
    const gone = await db.query<{ n: number }>(`select count(*)::int as n from public.availability`);
    expect(gone.rows).toEqual([{ n: 0 }]);
  });

  it("there is no update path at all — a yes is a row, a no is its absence", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `update public.availability set race_date_id = '${DRAFT}' where person_id = '${ANN}'`,
        ANN,
      ),
    ).rejects.toThrow(/permission denied for table availability/);
  });
});
