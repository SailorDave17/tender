import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0009 — club.admin_email and the two triggers that make its person an admin (story #64).
 *
 * Story #64 AC 1: a person whose contact email matches the club's admin_email case-insensitively
 * is created with is_admin = true; anyone else with false; both functions are definers with
 * search_path pinned and execute revoked from the client roles. AC 2 (as decided 2026-08-23): on
 * a project where the admin's person row already exists, setting admin_email on the club row is
 * what flags them — no statement against person is pasted by hand.
 *
 * The fixture is shared down the file. Each `it` creates the people it needs under its own ids,
 * so a trigger that fires when it should not (or fails to) leaves its mark on a row no other
 * test reads. The one shared piece of state is the club row, which the "set after the fact"
 * cases update in place and the later cases read back.
 *
 * Every deny is against `authenticated` with a positive control beside it. The escalation cases
 * at the end are the security argument for a trigger at all: no client role can write the row
 * that would fire it.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EARLY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // signed in before admin_email was set
const LATER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // signed in when the club still had no admin

const isAdmin = async (id: string) => {
  const r = await db.query<{ is_admin: boolean }>(`select is_admin from public.person where id = '${id}'`);
  expect(r.rows).toHaveLength(1); // the row must exist, or a missing person reads as "not admin"
  return r.rows[0].is_admin;
};

/** The server's insert, as the callback does it: person first, then the contact row. */
const signIn = (id: string, name: string, email: string) =>
  db.exec(`
    insert into auth.users (id) values ('${id}');
    insert into public.person (id, display_name, adult_attested_at) values ('${id}', '${name}', now());
    insert into public.person_contact (person_id, email) values ('${id}', '${email}');
  `);

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
  `);
});
afterAll(async () => {
  await db.close();
});

describe("admin_email (0009) — shape and grants", () => {
  it("the column is nullable and refuses a value with no @", async () => {
    const r = await db.query<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'club' and column_name = 'admin_email'`,
    );
    expect(r.rows).toEqual([{ is_nullable: "YES", data_type: "text" }]);
    await expect(db.exec(`update public.club set admin_email = 'nope'`)).rejects.toThrow(/check constraint/);
    // Positive control on the same statement shape: a value with an @ is accepted and read back.
    await db.exec(`update public.club set admin_email = 'probe@example.org'`);
    const back = await db.query<{ admin_email: string }>(`select admin_email from public.club`);
    expect(back.rows).toEqual([{ admin_email: "probe@example.org" }]);
    await db.exec(`update public.club set admin_email = null`);
  });

  it("admin_email is withheld from every client role (0002's column grant names its columns)", async () => {
    await expect(as(db, "authenticated", `select admin_email from public.club`)).rejects.toThrow(
      /permission denied/,
    );
    // Positive control: the columns 0002 grants are still readable by the same role.
    const r = await as(db, "authenticated", `select name from public.club`);
    expect(r.rows).toEqual([{ name: "Hoover Sailing Club" }]);
  });

  it("both trigger functions are definers with search_path pinned, and no client role may execute them", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean; pronargs: number; proconfig: string[] }>(
      `select proname, prosecdef, pronargs, proconfig from pg_proc
        where oid in ('public.admin_from_contact()'::regprocedure, 'public.admin_from_club()'::regprocedure)
        order by proname`,
    );
    expect(r.rows).toEqual([
      { proname: "admin_from_club", prosecdef: true, pronargs: 0, proconfig: ['search_path=""'] },
      { proname: "admin_from_contact", prosecdef: true, pronargs: 0, proconfig: ['search_path=""'] },
    ]);
    const priv = await db.query<{ fn: string; role: string; can: boolean }>(
      `select f.fn, r.role, has_function_privilege(r.role, f.fn, 'execute') as can
         from (values ('public.admin_from_contact()'), ('public.admin_from_club()')) as f(fn)
        cross join (values ('anon'), ('authenticated')) as r(role)
        order by 1, 2`,
    );
    expect(priv.rows.every((x) => x.can === false)).toBe(true);
    expect(priv.rows).toHaveLength(4);
    // Positive control for the privilege read: the superuser that owns them can execute.
    const own = await db.query<{ can: boolean }>(
      `select has_function_privilege(current_user, 'public.admin_from_club()', 'execute') as can`,
    );
    expect(own.rows).toEqual([{ can: true }]);
  });

  it("both triggers exist on the tables they watch, after the row is written", async () => {
    const r = await db.query<{ tgname: string; tgrelid: string; tgtype: number }>(
      `select tgname, tgrelid::regclass::text as tgrelid, tgtype from pg_trigger
        where tgname in ('person_contact_admin_from_club', 'club_admin_email_grants_admin')
        order by tgname`,
    );
    // tgtype bit 0 = ROW, bit 1 = BEFORE (clear = AFTER), bit 2 = INSERT, bit 4 = UPDATE.
    expect(r.rows).toEqual([
      { tgname: "club_admin_email_grants_admin", tgrelid: "club", tgtype: 1 + 4 + 16 },
      { tgname: "person_contact_admin_from_club", tgrelid: "person_contact", tgtype: 1 + 4 },
    ]);
  });
});

describe("admin_email (0009) — the first sign-in (AC 1)", () => {
  it("with no admin_email set, a new person is not an admin", async () => {
    await signIn(LATER, 'Lee', "lee@example.org");
    expect(await isAdmin(LATER)).toBe(false);
  });

  it("a person whose email matches admin_email — in a different case — is created an admin", async () => {
    await db.exec(`update public.club set admin_email = 'Coach@Example.org'`);
    await signIn(ADMIN, "Ada", "coach@example.org");
    expect(await isAdmin(ADMIN)).toBe(true);
  });

  it("a person whose email does not match is created with is_admin = false", async () => {
    await signIn(CREW, "Cy", "cy@example.org");
    expect(await isAdmin(CREW)).toBe(false);
  });
});

describe("admin_email (0009) — set after the person already exists (AC 2, as decided)", () => {
  it("setting admin_email on the club row flags the matching existing person, and nobody else", async () => {
    await signIn(EARLY, "Eve", "eve@example.org");
    expect(await isAdmin(EARLY)).toBe(false);
    const r = await db.query<{ id: string }>(
      `update public.club set admin_email = 'EVE@example.org' returning id`,
    );
    expect(r.rows).toHaveLength(1);
    expect(await isAdmin(EARLY)).toBe(true);
    expect(await isAdmin(CREW)).toBe(false);
    expect(await isAdmin(LATER)).toBe(false);
  });

  it("changing admin_email grants the new admin and does not revoke the old one", async () => {
    // Ada was flagged above and is no longer the configured address; grant-only means she stays.
    expect(await isAdmin(ADMIN)).toBe(true);
    expect(await isAdmin(EARLY)).toBe(true);
  });

  it("inserting a club row that already carries admin_email flags a pre-existing person too", async () => {
    // A fresh project where the seed is pasted after someone signed in — the insert arm of
    // the same trigger. One club row is the rule, so put the original back afterwards.
    const keep = await db.query<{ id: string; admin_email: string | null }>(`select id, admin_email from public.club`);
    await db.exec(`delete from public.club`);
    await db.exec(`
      insert into public.club (name, brand_disc, brand_mark, invite_code, admin_email)
        values ('Second seed', '#395FAC', '#FCCF0B', 'x', 'LEE@example.org');
    `);
    expect(await isAdmin(LATER)).toBe(true);
    await db.exec(`delete from public.club`);
    await db.exec(`
      insert into public.club (id, name, brand_disc, brand_mark, invite_code, admin_email)
        values ('${keep.rows[0].id}', 'Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me', '${keep.rows[0].admin_email}');
    `);
  });
});

describe("admin_email (0009) — no client route to the rows that fire the triggers", () => {
  it("a signed-in person cannot write their contact email, nor anyone's", async () => {
    await expect(
      as(db, "authenticated", `update public.person_contact set email = 'eve@example.org' where person_id = '${CREW}'`, CREW),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, "authenticated", `insert into public.person_contact (person_id, email) values ('${CREW}', 'eve@example.org')`, CREW),
    ).rejects.toThrow(/permission denied/);
    // Positive control: the same person reads their own contact row through the same role.
    const r = await as(db, "authenticated", `select email from public.person_contact where person_id = '${CREW}'`, CREW);
    expect(r.rows).toEqual([{ email: "cy@example.org" }]);
  });

  it("a signed-in person cannot set admin_email or is_admin themselves", async () => {
    await expect(
      as(db, "authenticated", `update public.club set admin_email = 'cy@example.org'`, CREW),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, "authenticated", `update public.person set is_admin = true where id = '${CREW}'`, CREW),
    ).rejects.toThrow(/permission denied/);
    // Positive control on the person update grant: display_name is the one column they may change.
    const r = await as(db, "authenticated", `update public.person set display_name = 'Cyrus' where id = '${CREW}' returning display_name`, CREW);
    expect(r.rows).toEqual([{ display_name: "Cyrus" }]);
    expect(await isAdmin(CREW)).toBe(false);
  });
});
