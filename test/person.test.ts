import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0002 — person, person_contact, and the narrowed club grant.
 *
 * Every deny case here is against `authenticated`, the role the migration grants something to.
 * There is deliberately no "anon cannot read person" case: the harness reproduces none of
 * Supabase's default grants (test/pglite.ts), so such a test passes whether or not the
 * migration's `revoke … from anon` exists — a test that cannot fail proves nothing. The anon
 * side is #48's, together with the harness change that would make it testable.
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
      { table_name: "person", privilege_type: "SELECT", column_name: "rating" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "any_hull" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "display_name" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "hulls" },
      { table_name: "person", privilege_type: "UPDATE", column_name: "rating" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "email" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "person_id" },
      { table_name: "person_contact", privilege_type: "SELECT", column_name: "phone" },
      { table_name: "person_contact", privilege_type: "UPDATE", column_name: "phone" },
    ]); // rating/any_hull/hulls and the phone update arrive with 0005 (story #18)
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
