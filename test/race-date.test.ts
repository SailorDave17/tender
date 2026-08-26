import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0004 — race_date and is_admin(). Story #17 AC 1: a signed-in non-admin reads published rows
 * only and can write nothing; an admin can insert, update and delete.
 *
 * As in person.test.ts, every deny is against `authenticated`: the harness grants anon nothing
 * Supabase would, so an anon case here could not fail (that side is #48's).
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PUBLISHED = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ADMIN}'), ('${CREW}');
    insert into public.person (id, display_name, is_admin, adult_attested_at)
      values ('${ADMIN}', 'Dave', true, now()), ('${CREW}', 'Crew', false, now());
    insert into public.race_date (id, starts_at, title, published) values
      ('${PUBLISHED}', '2027-04-11T17:00:00Z', 'Spring series 1', true),
      ('${DRAFT}', '2027-04-18T17:00:00Z', 'Spring series 2', false);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("race_date (0004) — shape", () => {
  it("exists with row level security on and starts_at NOT NULL", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.race_date'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const col = await db.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'race_date' and column_name = 'starts_at'`,
    );
    expect(col.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "NO" }]);
  });

  it("grants authenticated by column: id and created_at are never written by a client", async () => {
    const r = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'race_date'
        order by privilege_type, column_name`,
    );
    expect(r.rows).toEqual([
      { privilege_type: "INSERT", column_name: "published" },
      { privilege_type: "INSERT", column_name: "starts_at" },
      { privilege_type: "INSERT", column_name: "title" },
      { privilege_type: "SELECT", column_name: "created_at" },
      { privilege_type: "SELECT", column_name: "id" },
      { privilege_type: "SELECT", column_name: "published" },
      { privilege_type: "SELECT", column_name: "starts_at" },
      { privilege_type: "SELECT", column_name: "title" },
      { privilege_type: "UPDATE", column_name: "published" },
      { privilege_type: "UPDATE", column_name: "starts_at" },
      { privilege_type: "UPDATE", column_name: "title" },
    ]);
    // DELETE is table-level, the one whole-table privilege a client role holds here; the row
    // policy is what narrows it to admins. (column_privileges cannot see it — cairn:
    // supabase-rls-column-grants-2026-08-06.)
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'race_date'`,
    );
    expect(t.rows).toEqual([{ privilege_type: "DELETE" }]);
  });

  it("refuses a blank title and one over 80 characters at the table", async () => {
    await expect(
      db.exec(`insert into public.race_date (starts_at, title) values (now(), '')`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.exec(`insert into public.race_date (starts_at, title) values (now(), '${"x".repeat(81)}')`),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("is_admin() (0004)", () => {
  it("is true for the admin, false for a crew, false with no user", async () => {
    const a = await as(db, "authenticated", `select public.is_admin() as v`, ADMIN);
    expect(a.rows).toEqual([{ v: true }]);
    const c = await as(db, "authenticated", `select public.is_admin() as v`, CREW);
    expect(c.rows).toEqual([{ v: false }]);
    const n = await as(db, "authenticated", `select public.is_admin() as v`);
    expect(n.rows).toEqual([{ v: false }]);
  });
});

describe("race_date (0004) — a non-admin reads published rows and writes nothing (AC 1)", () => {
  it("select returns only the published row", async () => {
    const r = await as(
      db,
      "authenticated",
      `select id, title, published from public.race_date order by starts_at`,
      CREW,
    );
    expect(r.rows).toEqual([{ id: PUBLISHED, title: "Spring series 1", published: true }]);
  });

  it("insert is refused loudly (row-level security)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.race_date (starts_at, title) values ('2027-05-02T17:00:00Z', 'Sneaked in')`,
        CREW,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.race_date`);
    expect(n.rows).toEqual([{ n: 2 }]);
  });

  it("update touches zero rows — the published one included — and nothing changes", async () => {
    const r = await as(
      db,
      "authenticated",
      `update public.race_date set title = 'Vandalised', published = true`,
      CREW,
    );
    expect(r.affectedRows ?? 0).toBe(0);
    const after = await db.query<{ title: string; published: boolean }>(
      `select title, published from public.race_date order by starts_at`,
    );
    expect(after.rows).toEqual([
      { title: "Spring series 1", published: true },
      { title: "Spring series 2", published: false },
    ]);
  });

  it("delete touches zero rows", async () => {
    const r = await as(db, "authenticated", `delete from public.race_date`, CREW);
    expect(r.affectedRows ?? 0).toBe(0);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.race_date`);
    expect(n.rows).toEqual([{ n: 2 }]);
  });
});

describe("race_date (0004) — the admin does all three (AC 1)", () => {
  it("select returns every row, unpublished included", async () => {
    const r = await as(
      db,
      "authenticated",
      `select id, published from public.race_date order by starts_at`,
      ADMIN,
    );
    expect(r.rows).toEqual([
      { id: PUBLISHED, published: true },
      { id: DRAFT, published: false },
    ]);
  });

  it("insert, then update (publish), then delete — each lands", async () => {
    const ins = await as(
      db,
      "authenticated",
      `insert into public.race_date (starts_at, title) values ('2027-05-02T17:00:00Z', 'Spring series 3')`,
      ADMIN,
    );
    expect(ins.affectedRows).toBe(1);
    const row = await db.query<{ id: string; published: boolean }>(
      `select id, published from public.race_date where title = 'Spring series 3'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].published).toBe(false); // the default: entered, not yet shown
    const id = row.rows[0].id;

    const upd = await as(
      db,
      "authenticated",
      `update public.race_date set published = true where id = '${id}'`,
      ADMIN,
    );
    expect(upd.affectedRows).toBe(1);
    const seen = await as(
      db,
      "authenticated",
      `select title from public.race_date where id = '${id}'`,
      CREW,
    );
    expect(seen.rows).toEqual([{ title: "Spring series 3" }]); // now a crew can see it

    const del = await as(db, "authenticated", `delete from public.race_date where id = '${id}'`, ADMIN);
    expect(del.affectedRows).toBe(1);
    const gone = await db.query<{ n: number }>(
      `select count(*)::int as n from public.race_date where id = '${id}'`,
    );
    expect(gone.rows).toEqual([{ n: 0 }]);
  });

  it("cannot choose the id or created_at (column grant), even as admin", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.race_date (id, starts_at, title)
           values ('33333333-3333-4333-8333-333333333333', now(), 'Chosen id')`,
        ADMIN,
      ),
    ).rejects.toThrow(/permission denied for table race_date/);
    await expect(
      as(
        db,
        "authenticated",
        `update public.race_date set created_at = now() where id = '${DRAFT}'`,
        ADMIN,
      ),
    ).rejects.toThrow(/permission denied for table race_date/);
  });
});
