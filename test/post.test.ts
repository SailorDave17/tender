import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0006 — boat and post. Story #19 AC 1: every signed-in person reads posts on published dates;
 * only the boat's owner inserts or closes; a non-owner's insert is refused; a post against an
 * unpublished or a past date is refused.
 *
 * Every deny is against `authenticated` with a positive control on the same mechanism beside
 * it (see person.test.ts for why there is no anon case).
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
let BOAT = ""; // assigned by the database in the first boat test; a client cannot choose it
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DRAFT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GONE = "ffffffff-ffff-4fff-8fff-ffffffffffff";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}'), ('${ADMIN}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${SKIPPER}', 'Sam', now(), 3, false),
      ('${CREW}', 'Cy', now(), 2, false),
      ('${ADMIN}', 'Dave', now(), 3, true);
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', now() + interval '7 days', 'Spring series 1', true),
      ('${NEXT}', now() + interval '14 days', 'Spring series 2', true),
      ('${DRAFT}', now() + interval '21 days', 'Spring series 3 (draft)', false),
      ('${GONE}', now() - interval '7 days', 'Last Sunday', true);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("boat (0006) — shape and grants", () => {
  it("exists with RLS on; class references boat_class; owner cascades", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.boat'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const fk = await db.query<{ confrelid: string; confdeltype: string }>(
      `select confrelid::regclass::text as confrelid, confdeltype from pg_constraint
        where conrelid = 'public.boat'::regclass and contype = 'f' order by confrelid`,
    );
    expect(fk.rows).toEqual([
      { confrelid: "boat_class", confdeltype: "a" },
      { confrelid: "person", confdeltype: "c" },
    ]);
  });

  it("refuses a class not in the fleet list and a minimum outside 1..3 at the table", async () => {
    await expect(
      db.exec(`insert into public.boat (owner_id, name, class, default_minimum)
                 values ('${SKIPPER}', 'Rogue', 'Laser', 2)`),
    ).rejects.toThrow(/foreign key/);
    await expect(
      db.exec(`insert into public.boat (owner_id, name, class, default_minimum)
                 values ('${SKIPPER}', 'Rogue', 'Thistle', 4)`),
    ).rejects.toThrow(/check constraint/);
  });

  it("grants authenticated by column — id and created_at never written by a client", async () => {
    const r = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'boat'
        order by privilege_type, column_name`,
    );
    expect(r.rows.map((x) => `${x.privilege_type}:${x.column_name}`)).toEqual([
      "INSERT:class",
      "INSERT:default_minimum",
      "INSERT:name",
      "INSERT:owner_id",
      "SELECT:class",
      "SELECT:created_at",
      "SELECT:default_minimum",
      "SELECT:id",
      "SELECT:name",
      "SELECT:owner_id",
      "UPDATE:class",
      "UPDATE:default_minimum",
      "UPDATE:name",
    ]);
  });
});

describe("boat (0006) — owning one is what makes a skipper", () => {
  it("a person adds a boat of their own and everyone can see it", async () => {
    const i = await as(
      db,
      "authenticated",
      `insert into public.boat (owner_id, name, class, default_minimum)
         values ('${SKIPPER}', 'Blue Moon', 'Thistle', 2)`,
      SKIPPER,
    );
    expect(i.affectedRows).toBe(1);
    const id = await db.query<{ id: string }>(`select id from public.boat where name = 'Blue Moon'`);
    expect(id.rows).toHaveLength(1);
    BOAT = id.rows[0].id;
    const seen = await as(
      db,
      "authenticated",
      `select name, class, default_minimum from public.boat`,
      CREW,
    );
    expect(seen.rows).toEqual([{ name: "Blue Moon", class: "Thistle", default_minimum: 2 }]);
  });

  it("a person cannot add a boat owned by someone else (row-level security)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.boat (owner_id, name, class, default_minimum)
           values ('${SKIPPER}', 'Hijack', 'Interlake', 1)`,
        CREW,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.boat`);
    expect(n.rows).toEqual([{ n: 1 }]);
  });

  it("a client cannot choose a boat's id (column grant), even its owner", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.boat (id, owner_id, name, class, default_minimum)
           values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${SKIPPER}', 'Chosen id', 'Interlake', 1)`,
        SKIPPER,
      ),
    ).rejects.toThrow(/permission denied for table boat/);
  });

  it("a non-owner's update or delete matches zero rows; the owner's lands", async () => {
    const u = await as(db, "authenticated", `update public.boat set name = 'Stolen'`, CREW);
    expect(u.affectedRows ?? 0).toBe(0);
    const d = await as(db, "authenticated", `delete from public.boat`, CREW);
    expect(d.affectedRows ?? 0).toBe(0);
    const own = await as(
      db,
      "authenticated",
      `update public.boat set default_minimum = 1 where id = '${BOAT}'`,
      SKIPPER,
    );
    expect(own.affectedRows).toBe(1);
    await db.exec(`update public.boat set default_minimum = 2 where id = '${BOAT}'`);
  });

  it("owns_boat() answers for the caller: true for the owner, false for anyone else or nobody", async () => {
    const o = await as(db, "authenticated", `select public.owns_boat('${BOAT}') as v`, SKIPPER);
    expect(o.rows).toEqual([{ v: true }]);
    const c = await as(db, "authenticated", `select public.owns_boat('${BOAT}') as v`, CREW);
    expect(c.rows).toEqual([{ v: false }]);
    const n = await as(db, "authenticated", `select public.owns_boat('${BOAT}') as v`);
    expect(n.rows).toEqual([{ v: false }]);
  });
});

describe("post (0006) — shape and grants", () => {
  it("exists with RLS on, one post per boat per date, note capped, closed_at nullable", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.post'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const u = await db.query<{ cols: string[] }>(
      `select array_agg(a.attname order by a.attnum) as cols
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'public.post'::regclass and c.contype = 'u'`,
    );
    expect(u.rows).toEqual([{ cols: ["boat_id", "race_date_id"] }]);
    const closed = await db.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'post' and column_name = 'closed_at'`,
    );
    expect(closed.rows).toEqual([{ is_nullable: "YES" }]);
    await expect(
      db.exec(`insert into public.post (boat_id, race_date_id, minimum, note)
                 values ('${BOAT}', '${NEXT}', 2, '${"x".repeat(281)}')`),
    ).rejects.toThrow(/check constraint/);
  });

  it("grants: insert four columns, update closed_at only, no delete at all", async () => {
    const r = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'post'
          and privilege_type in ('INSERT', 'UPDATE')
        order by privilege_type, column_name`,
    );
    expect(r.rows.map((x) => `${x.privilege_type}:${x.column_name}`)).toEqual([
      "INSERT:boat_id",
      "INSERT:minimum",
      "INSERT:note",
      "INSERT:race_date_id",
      "UPDATE:closed_at",
    ]);
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'post'`,
    );
    expect(t.rows).toEqual([]); // no whole-table privilege: in particular no DELETE
  });
});

describe("post (0006) — AC 1: only the boat's owner posts, and only against a live date", () => {
  it("the owner posts a need for a published future date", async () => {
    const i = await as(
      db,
      "authenticated",
      `insert into public.post (boat_id, race_date_id, minimum, note)
         values ('${BOAT}', '${SUNDAY}', 2, 'Need one for the jib')`,
      SKIPPER,
    );
    expect(i.affectedRows).toBe(1);
  });

  it("a non-owner's insert for that boat is refused (row-level security), and nothing lands", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.post (boat_id, race_date_id, minimum, note)
           values ('${BOAT}', '${NEXT}', 1, 'Not my boat')`,
        CREW,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.post`);
    expect(n.rows).toEqual([{ n: 1 }]);
  });

  it("the owner cannot post against an unpublished date (refused)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.post (boat_id, race_date_id, minimum) values ('${BOAT}', '${DRAFT}', 2)`,
        SKIPPER,
      ),
    ).rejects.toThrow(/row-level security policy/);
  });

  it("an admin who owns a boat cannot post against a draft date either — the policy's own published clause refuses it", async () => {
    // A non-admin never sees a draft (0004's read policy), so for them the clause above is
    // redundant and a mutation dropping it reddens nothing (measured: 0 of 2 predicted). An
    // admin CAN read drafts, so this is the case where `r.published` in the insert policy is
    // the only thing refusing the post (prove-tests shape 9: pick the fixture on which the
    // constraint and the unconstrained rule disagree).
    const mine = await as(
      db,
      "authenticated",
      `insert into public.boat (owner_id, name, class, default_minimum) values ('${ADMIN}', 'Committee', 'Interlake', 1)`,
      ADMIN,
    );
    expect(mine.affectedRows).toBe(1);
    const id = await db.query<{ id: string }>(`select id from public.boat where name = 'Committee'`);
    const adminBoat = id.rows[0].id;
    const draft = await as(db, "authenticated", `select id from public.race_date where id = '${DRAFT}'`, ADMIN);
    expect(draft.rows).toHaveLength(1); // the admin can see the draft: the read policy is not what refuses below
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.post (boat_id, race_date_id, minimum) values ('${adminBoat}', '${DRAFT}', 1)`,
        ADMIN,
      ),
    ).rejects.toThrow(/row-level security policy/);
    // Positive control: the same admin, same boat, a published date — lands.
    const ok = await as(
      db,
      "authenticated",
      `insert into public.post (boat_id, race_date_id, minimum) values ('${adminBoat}', '${SUNDAY}', 1)`,
      ADMIN,
    );
    expect(ok.affectedRows).toBe(1);
    await db.exec(`delete from public.post where boat_id = '${adminBoat}'; delete from public.boat where id = '${adminBoat}'`);
  });

  it("the owner cannot post against a date already started (refused)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.post (boat_id, race_date_id, minimum) values ('${BOAT}', '${GONE}', 2)`,
        SKIPPER,
      ),
    ).rejects.toThrow(/row-level security policy/);
    // Positive control for the two refusals above: the same boat, a second live date, lands.
    const ok = await as(
      db,
      "authenticated",
      `insert into public.post (boat_id, race_date_id, minimum) values ('${BOAT}', '${NEXT}', 3)`,
      SKIPPER,
    );
    expect(ok.affectedRows).toBe(1);
  });

  it("a second post for the same boat and date is refused by the unique constraint", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.post (boat_id, race_date_id, minimum) values ('${BOAT}', '${SUNDAY}', 1)`,
        SKIPPER,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("every signed-in person reads the posts, with the boat's minimum and note", async () => {
    const r = await as(
      db,
      "authenticated",
      `select p.minimum, p.note, b.name from public.post p join public.boat b on b.id = p.boat_id
        order by p.minimum`,
      CREW,
    );
    expect(r.rows).toEqual([
      { minimum: 2, note: "Need one for the jib", name: "Blue Moon" },
      { minimum: 3, note: "", name: "Blue Moon" },
    ]);
  });

  it("a post on a date that is later unpublished disappears from a crew's read, and an admin's", async () => {
    await db.exec(`update public.race_date set published = false where id = '${NEXT}'`);
    const crew = await as(db, "authenticated", `select race_date_id from public.post`, CREW);
    expect(crew.rows).toEqual([{ race_date_id: SUNDAY }]);
    const admin = await as(db, "authenticated", `select race_date_id from public.post`, ADMIN);
    expect(admin.rows).toEqual([{ race_date_id: SUNDAY }]); // the admin can read the draft date, not a post on it
    await db.exec(`update public.race_date set published = true where id = '${NEXT}'`);
  });
});

describe("post (0006) — AC 1 / AC 6: only the owner closes", () => {
  it("a non-owner's close matches zero rows", async () => {
    const u = await as(db, "authenticated", `update public.post set closed_at = now()`, CREW);
    expect(u.affectedRows ?? 0).toBe(0);
    const open = await db.query<{ n: number }>(
      `select count(*)::int as n from public.post where closed_at is null`,
    );
    expect(open.rows).toEqual([{ n: 2 }]);
  });

  it("the owner cannot change minimum or note after posting (column grant) — only closed_at", async () => {
    await expect(
      as(db, "authenticated", `update public.post set minimum = 1 where race_date_id = '${SUNDAY}'`, SKIPPER),
    ).rejects.toThrow(/permission denied for table post/);
  });

  it("the owner closes their post and it stays readable, closed", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.post set closed_at = now() where race_date_id = '${SUNDAY}'`,
      SKIPPER,
    );
    expect(u.affectedRows).toBe(1);
    const r = await as(
      db,
      "authenticated",
      `select race_date_id, closed_at is not null as closed from public.post order by closed`,
      CREW,
    );
    expect(r.rows).toEqual([
      { race_date_id: NEXT, closed: false },
      { race_date_id: SUNDAY, closed: true },
    ]);
  });

  it("nobody deletes a post, the owner included (no grant)", async () => {
    await expect(as(db, "authenticated", `delete from public.post`, SKIPPER)).rejects.toThrow(
      /permission denied for table post/,
    );
  });
});
