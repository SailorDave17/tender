import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { standingFromRow } from "@/auth/gate";
import { applyMigration, as, freshDb } from "./pglite";

/**
 * 0002 — person, person_contact, and the narrowed club grant.
 *
 * Every deny case here is against `authenticated`, the role the migration grants something to.
 * There is deliberately no "anon cannot read person" case HERE, and the reason changed on
 * 2026-08-30. It used to be that such a test could not fail: the harness reproduced none of
 * Supabase's default grants, so it passed whether or not the migration's `revoke … from anon`
 * existed. Since story #48 the harness DOES reproduce them for anon and authenticated, so the
 * anon side is testable — and it is tested once, as a sweep over every table in the schema, in
 * test/anon-grants.test.ts. A per-table copy here would add nothing the sweep does not catch.
 */

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
    insert into public.person (id, display_name, adult_attested_at)
      values ('${ALICE}', 'Alice', now()), ('${BOB}', 'Bob', now());
    insert into public.person_contact (person_id, email, phone)
      values ('${ALICE}', 'alice@example.org', '614-555-0100'),
             ('${BOB}', 'bob@example.org', null);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("person and person_contact (0002) — shape", () => {
  it("both tables exist with row level security on", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where oid in ('public.person'::regclass, 'public.person_contact'::regclass)
        order by relname`,
    );
    expect(r.rows).toEqual([
      { relname: "person", relrowsecurity: true },
      { relname: "person_contact", relrowsecurity: true },
    ]);
  });

  it("person.id is auth.users.id and cascades on delete", async () => {
    const r = await db.query<{ confdeltype: string; confrelid: string }>(
      `select confdeltype, confrelid::regclass::text as confrelid from pg_constraint
        where conrelid = 'public.person'::regclass and contype = 'f'`,
    );
    expect(r.rows).toEqual([{ confdeltype: "c", confrelid: "auth.users" }]);
  });

  it("person_contact is 1:1 with person and cascades on delete", async () => {
    const r = await db.query<{ contype: string; confdeltype: string }>(
      `select contype, confdeltype from pg_constraint
        where conrelid = 'public.person_contact'::regclass and contype in ('p', 'f')
        order by contype`,
    );
    expect(r.rows).toEqual([
      { contype: "f", confdeltype: "c" },
      { contype: "p", confdeltype: " " },
    ]);
  });

  it("the grants to authenticated are explicit columns, not whole rows", async () => {
    const r = await db.query<{ table_name: string; privilege_type: string; column_name: string }>(
      `select table_name, privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public'
          and table_name in ('person', 'person_contact', 'club')
        order by table_name, privilege_type, column_name`,
    );
    expect(r.rows).toEqual([
      { table_name: "club", privilege_type: "SELECT", column_name: "brand_disc" },
      { table_name: "club", privilege_type: "SELECT", column_name: "brand_mark" },
      { table_name: "club", privilege_type: "SELECT", column_name: "created_at" },
      { table_name: "club", privilege_type: "SELECT", column_name: "id" },
      { table_name: "club", privilege_type: "SELECT", column_name: "name" },
      { table_name: "person", privilege_type: "SELECT", column_name: "any_hull" },
      { table_name: "person", privilege_type: "SELECT", column_name: "created_at" },
      { table_name: "person", privilege_type: "SELECT", column_name: "display_name" },
      { table_name: "person", privilege_type: "SELECT", column_name: "hulls" },
      { table_name: "person", privilege_type: "SELECT", column_name: "id" },
      { table_name: "person", privilege_type: "SELECT", column_name: "is_admin" },
      { table_name: "person", privilege_type: "SELECT", column_name: "profile_completed_at" },
      { table_name: "person", privilege_type: "SELECT", column_name: "rating" },
      { table_name: "person", privilege_type: "SELECT", column_name: "skills" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "any_hull" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "display_name" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "hulls" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "profile_completed_at" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "rating" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "skills" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "email" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "person_id" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "phone" },
      { table_name: "person_contact", privilege_type: "UPDATE", column_name: "phone" },
    ]); // rating/any_hull/hulls and the phone update arrive with 0005 (story #18); skills with
    // 0024 (story #68), select AND update, beside rating and through the same self-only policy;
    // profile_completed_at with 0031 (story #219), the same way
  });

  it("authenticated holds no whole-table privilege on person, person_contact or club", async () => {
    // column_privileges cannot see DELETE, TRUNCATE, TRIGGER or REFERENCES — they are table-level
    // and structurally absent from it (cairn: supabase-rls-column-grants-2026-08-06). Only
    // table_privileges can, and it in turn lists no column-level grant, so "nothing here" is the
    // correct reading for a role granted by column — provided the catalog can see a grant at all.
    const control = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.table_privileges
        where grantee = current_user and table_schema = 'public' and table_name = 'person'
          and privilege_type = 'DELETE'`,
    );
    expect(control.rows[0].n).toBe(1); // the owner's DELETE is visible, so an empty read below means revoked

    const r = await db.query<{ table_name: string; privilege_type: string }>(
      `select distinct table_name, privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public'
          and table_name in ('person', 'person_contact', 'club')
        order by table_name, privilege_type`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("person (0002) — adults only is structural", () => {
  it("refuses a person row with no attestation", async () => {
    await expect(
      db.exec(`insert into auth.users (id) values ('33333333-3333-4333-8333-333333333333');
               insert into public.person (id, display_name, adult_attested_at)
                 values ('33333333-3333-4333-8333-333333333333', 'Nobody', null);`),
    ).rejects.toThrow(/null value in column "adult_attested_at"/);
  });
});

describe("the harness — a call with no user does not inherit the previous user", () => {
  it("auth.uid() is null after a call made as someone", async () => {
    const asAlice = await as(db, "authenticated", `select auth.uid()::text as uid`, ALICE);
    expect(asAlice.rows).toEqual([{ uid: ALICE }]);
    const asNobody = await as(db, "authenticated", `select auth.uid()::text as uid`);
    expect(asNobody.rows).toEqual([{ uid: null }]);
  });
});

describe("person (0002) — who can read what", () => {
  it("a signed-in person reads their own person row and their own contact row", async () => {
    const me = await as(
      db,
      "authenticated",
      `select id, display_name, is_admin from public.person where id = '${ALICE}'`,
      ALICE,
    );
    expect(me.rows).toEqual([{ id: ALICE, display_name: "Alice", is_admin: false }]);
    const contact = await as(
      db,
      "authenticated",
      `select person_id, email, phone from public.person_contact`,
      ALICE,
    );
    expect(contact.rows).toEqual([
      { person_id: ALICE, email: "alice@example.org", phone: "614-555-0100" },
    ]);
  });

  it("id, display_name and is_admin are readable for every person", async () => {
    const r = await as(
      db,
      "authenticated",
      `select id, display_name, is_admin from public.person order by display_name`,
      BOB,
    );
    expect(r.rows).toEqual([
      { id: ALICE, display_name: "Alice", is_admin: false },
      { id: BOB, display_name: "Bob", is_admin: false },
    ]);
  });

  it("another person's contact row is zero rows, not an error", async () => {
    const r = await as(
      db,
      "authenticated",
      `select email from public.person_contact where person_id = '${ALICE}'`,
      BOB,
    );
    expect(r.rows).toEqual([]);
  });

  it("adult_attested_at is not readable by a client, so select * on person fails loudly", async () => {
    await expect(as(db, "authenticated", `select * from public.person`, ALICE)).rejects.toThrow(
      /permission denied for table person/,
    );
    await expect(
      as(db, "authenticated", `select adult_attested_at from public.person`, ALICE),
    ).rejects.toThrow(/permission denied for table person/);
  });
});

describe("person (0002) — who can change what", () => {
  it("a person can change their own display_name and it persists", async () => {
    await as(
      db,
      "authenticated",
      `update public.person set display_name = 'Alice B' where id = '${ALICE}'`,
      ALICE,
    );
    const r = await db.query<{ display_name: string }>(
      `select display_name from public.person where id = '${ALICE}'`,
    );
    expect(r.rows).toEqual([{ display_name: "Alice B" }]);
  });

  it("a person cannot change another person's display_name (zero rows, policy)", async () => {
    const r = await as(
      db,
      "authenticated",
      `update public.person set display_name = 'Mallory' where id = '${BOB}'`,
      ALICE,
    );
    expect(r.affectedRows ?? 0).toBe(0);
    const check = await db.query<{ display_name: string }>(
      `select display_name from public.person where id = '${BOB}'`,
    );
    expect(check.rows).toEqual([{ display_name: "Bob" }]);
  });

  it("is_admin and adult_attested_at are refused even on the person's own row (column grant)", async () => {
    await expect(
      as(db, "authenticated", `update public.person set is_admin = true where id = '${ALICE}'`, ALICE),
    ).rejects.toThrow(/permission denied for table person/);
    await expect(
      as(
        db,
        "authenticated",
        `update public.person set adult_attested_at = now() where id = '${ALICE}'`,
        ALICE,
      ),
    ).rejects.toThrow(/permission denied for table person/);
    const r = await db.query<{ is_admin: boolean }>(
      `select is_admin from public.person where id = '${ALICE}'`,
    );
    expect(r.rows).toEqual([{ is_admin: false }]);
  });

  it("a person cannot write their own email (no grant) — phone became writable in 0005, see availability.test.ts", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `update public.person_contact set email = 'alice@elsewhere.org' where person_id = '${ALICE}'`,
        ALICE,
      ),
    ).rejects.toThrow(/permission denied for table person_contact/);
  });
});

describe("person.profile_completed_at (0031, story #219)", () => {
  /**
   * AC 1 needs members that exist BEFORE the migration runs, so this block boots its own database
   * `through: "0030"` and applies 0031 by hand — the only way to test a backfill (the harness says
   * why). It boots after the file's shared database, never beside it: two pglites in parallel in
   * one file pushed the harness budget test over on a busy machine (tender overlay, #24).
   */
  const CAROL = "33333333-3333-4333-8333-333333333333";
  const DAN = "44444444-4444-4444-8444-444444444444";
  let pre: PGlite;

  beforeAll(async () => {
    pre = await freshDb({ through: "0030" });
    await pre.exec(`
      insert into auth.users (id) values ('${CAROL}'), ('${DAN}');
      insert into public.person (id, display_name, adult_attested_at)
        values ('${CAROL}', 'Carol', now()), ('${DAN}', 'Dan', now());
    `);
  });
  afterAll(async () => {
    await pre.close();
  });

  it("does not exist through 0030 — so the rows above really predate it", async () => {
    const r = await pre.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = 'person' and column_name = 'profile_completed_at'`,
    );
    expect(r.rows).toEqual([{ n: 0 }]);
  });

  it("backfills every existing member as finished, so none is ever sent to /welcome (AC 1)", async () => {
    await applyMigration(pre, "0031");
    const r = await pre.query<{ id: string; profile_completed_at: Date | null }>(
      `select id, profile_completed_at from public.person order by id`,
    );
    expect(r.rows.map((x) => x.id)).toEqual([CAROL, DAN]);
    for (const row of r.rows) {
      expect(row.profile_completed_at, row.id).not.toBeNull();
      // The proxy's own reading of that row: finished, so the gate answers null on /board.
      expect(standingFromRow({ profile_completed_at: String(row.profile_completed_at) }, null)).toBe("finished");
    }
  });

  it("a member created after it, by today's sign-up, is finished too — until #220 inserts NULL", async () => {
    const EVE = "55555555-5555-4555-8555-555555555555";
    await pre.exec(`
      insert into auth.users (id) values ('${EVE}');
      insert into public.person (id, display_name, adult_attested_at) values ('${EVE}', 'Eve', now());
    `);
    const r = await pre.query<{ done: boolean }>(
      `select profile_completed_at is not null as done from public.person where id = '${EVE}'`,
    );
    expect(r.rows).toEqual([{ done: true }]);
  });

  it("a member can set their own (the positive control for the refusal below)", async () => {
    await pre.exec(`update public.person set profile_completed_at = null where id = '${CAROL}'`);
    const r = await as(
      pre,
      "authenticated",
      `update public.person set display_name = 'Carol B', profile_completed_at = now() where id = '${CAROL}'
        returning id`,
      CAROL,
    );
    expect(r.rows).toEqual([{ id: CAROL }]);
    const check = await pre.query<{ done: boolean }>(
      `select profile_completed_at is not null as done from public.person where id = '${CAROL}'`,
    );
    expect(check.rows).toEqual([{ done: true }]);
  });

  it("RLS refuses a client setting profile_completed_at on another member's row (AC 4)", async () => {
    await pre.exec(`update public.person set profile_completed_at = null where id = '${DAN}'`);
    const r = await as(
      pre,
      "authenticated",
      `update public.person set profile_completed_at = now() where id = '${DAN}'`,
      CAROL,
    );
    expect(r.affectedRows ?? 0).toBe(0);
    const check = await pre.query<{ done: boolean }>(
      `select profile_completed_at is not null as done from public.person where id = '${DAN}'`,
    );
    expect(check.rows).toEqual([{ done: false }]);
  });
});

describe("club (0002) — invite_code withheld from clients", () => {
  it("a signed-in person cannot read invite_code (42501)", async () => {
    await expect(
      as(db, "authenticated", `select invite_code from public.club`, ALICE),
    ).rejects.toThrow(/permission denied for table club/);
  });

  it("a signed-in person still reads the club's name and theme", async () => {
    const r = await as(
      db,
      "authenticated",
      `select name, brand_disc, brand_mark from public.club`,
      ALICE,
    );
    expect(r.rows).toEqual([
      { name: "Hoover Sailing Club", brand_disc: "#395FAC", brand_mark: "#FCCF0B" },
    ]);
  });

  it("select * on club now fails, which is what makes a wildcard in the app a loud error", async () => {
    await expect(as(db, "authenticated", `select * from public.club`, ALICE)).rejects.toThrow(
      /permission denied for table club/,
    );
  });
});
