import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0010 — post.current_rung, suggestion and notification_log (story #23 AC 1).
 *
 * Three claims: the shapes the AC names exist; every write path is the service role's alone
 * (authenticated refused on each, service_role the positive control on the same statement);
 * and current_rung is monotone (2 → 1 refused, 2 → 3 allowed, both through the trigger).
 *
 * Every deny is against `authenticated` with service_role beside it. The harness creates
 * service_role `bypassrls` as Supabase does, so a service_role case here measures the grants
 * this file makes and nothing the hosted project adds by default.
 */

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const POST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${SKIPPER}', 'Sam Skipper', now(), 3), ('${CREW}', 'Robin Crew', now(), 2);
    insert into public.person_contact (person_id, email) values
      ('${SKIPPER}', 'sam@example.org'), ('${CREW}', 'robin@example.org');
    insert into public.race_date (id, starts_at, title, published)
      values ('${DATE}', now() + interval '7 days', 'Spring Series 3', true);
    insert into public.boat (id, owner_id, name, class, default_minimum)
      values ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
    insert into public.post (id, boat_id, race_date_id, minimum) values ('${POST}', '${BOAT}', '${DATE}', 2);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("post.current_rung (0010)", () => {
  it("exists, defaults to 1, and is readable by authenticated beside the 0006 columns", async () => {
    const r = await as(db, "authenticated", `select id, current_rung from public.post where id = '${POST}'`, CREW);
    expect(r.rows).toEqual([{ id: POST, current_rung: 1 }]);
  });

  it("authenticated may not update it, even the boat's owner; service_role may", async () => {
    await expect(as(db, "authenticated", `update public.post set current_rung = 2 where id = '${POST}'`, SKIPPER)).rejects.toThrow(
      /permission denied/,
    );
    // Positive control on the same statement shape, as the server writes it.
    const r = await as(db, "service_role", `update public.post set current_rung = 2 where id = '${POST}' returning current_rung`);
    expect(r.rows).toEqual([{ current_rung: 2 }]);
  });

  it("refuses a decrease (2 → 1) with check_violation and allows an increase (2 → 3)", async () => {
    const before = await db.query<{ current_rung: number }>(`select current_rung from public.post where id = '${POST}'`);
    expect(before.rows).toEqual([{ current_rung: 2 }]); // the precondition, or the cases below prove nothing
    await expect(as(db, "service_role", `update public.post set current_rung = 1 where id = '${POST}'`)).rejects.toThrow(
      /may not decrease \(2 -> 1\)/,
    );
    const still = await db.query<{ current_rung: number }>(`select current_rung from public.post where id = '${POST}'`);
    expect(still.rows).toEqual([{ current_rung: 2 }]);
    const up = await as(db, "service_role", `update public.post set current_rung = 3 where id = '${POST}' returning current_rung`);
    expect(up.rows).toEqual([{ current_rung: 3 }]);
    // Back down for the later cases is impossible by design; the value stays 3 from here.
  });

  it("the check constraint bounds it to 1..3 and the trigger function is not executable by a client role", async () => {
    await expect(as(db, "service_role", `update public.post set current_rung = 4 where id = '${POST}'`)).rejects.toThrow(/check constraint/);
    const r = await db.query<{ auth: boolean; anon: boolean }>(
      `select has_function_privilege('authenticated', 'public.post_rung_monotone()', 'execute') as auth,
              has_function_privilege('anon', 'public.post_rung_monotone()', 'execute') as anon`,
    );
    expect(r.rows).toEqual([{ auth: false, anon: false }]);
  });
});

describe("suggestion (0010)", () => {
  it("has the AC's shape: (post_id, person_id) primary key, rung 1..3, notified_at nullable", async () => {
    const cols = await db.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'suggestion' order by column_name`,
    );
    expect(cols.rows).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "notified_at", is_nullable: "YES" },
      { column_name: "person_id", is_nullable: "NO" },
      { column_name: "post_id", is_nullable: "NO" },
      // 0013 (#29): the push half of the same ledger row. A second column rather than sharing
      // notified_at, because a send skipped at the email cap must not re-push tomorrow.
      { column_name: "pushed_at", is_nullable: "YES" },
      { column_name: "rung", is_nullable: "NO" },
    ]);
    const pk = await db.query<{ cols: string }>(
      `select string_agg(a.attname, ',' order by a.attnum) as cols
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = 'public.suggestion'::regclass and i.indisprimary`,
    );
    expect(pk.rows).toEqual([{ cols: "post_id,person_id" }]);
  });

  it("authenticated insert is refused — the crew's own row included; service_role inserts, and a second insert of the pair is 23505", async () => {
    const insert = (role: "authenticated" | "service_role") =>
      as(db, role, `insert into public.suggestion (post_id, person_id, rung) values ('${POST}', '${CREW}', 1)`, role === "authenticated" ? CREW : undefined);
    await expect(insert("authenticated")).rejects.toThrow(/permission denied/);
    const r = await db.query(`select 1 from public.suggestion`);
    expect(r.rows).toEqual([]); // the refusal left nothing behind
    await insert("service_role");
    await expect(insert("service_role")).rejects.toThrow(/duplicate key/);
    // Reads: authenticated has no select either — the ledger is the system's, not the board's.
    await expect(as(db, "authenticated", `select * from public.suggestion`, CREW)).rejects.toThrow(/permission denied/);
    const seen = await as(db, "service_role", `select person_id, rung, notified_at from public.suggestion`);
    expect(seen.rows).toEqual([{ person_id: CREW, rung: 1, notified_at: null }]);
  });

  it("service_role may set notified_at and nothing else on an existing row", async () => {
    // Read the row back: an update that matches zero rows does not throw, so without `returning`
    // this case passed with the harness's bypassrls removed (measured on this file's own
    // mutation pass, story #23) — the write has to be seen to have landed.
    const marked = await as(
      db,
      "service_role",
      `update public.suggestion set notified_at = now() where post_id = '${POST}' and person_id = '${CREW}' returning notified_at`,
    );
    expect(marked.rows).toHaveLength(1);
    expect((marked.rows[0] as { notified_at: Date | null }).notified_at).not.toBeNull();
    await expect(as(db, "service_role", `update public.suggestion set rung = 2 where post_id = '${POST}'`)).rejects.toThrow(/permission denied/);
    await expect(as(db, "authenticated", `update public.suggestion set notified_at = null where post_id = '${POST}'`, CREW)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("notification_log (0010)", () => {
  it("has the AC's columns and a channel check", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'notification_log' order by column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "channel",
      "error",
      "id",
      "kind",
      "person_id",
      "post_id",
      "provider_id",
      "sent_at",
      "to_email",
    ]);
    await expect(
      as(db, "service_role", `insert into public.notification_log (kind, channel, person_id, post_id) values ('rung_email', 'sms', '${CREW}', '${POST}')`),
    ).rejects.toThrow(/check constraint/);
  });

  it("authenticated insert is refused; service_role inserts and reads", async () => {
    const insert = (role: "authenticated" | "service_role") =>
      as(
        db,
        role,
        `insert into public.notification_log (kind, channel, person_id, to_email, post_id, provider_id)
           values ('rung_email', 'email', '${CREW}', 'robin@example.org', '${POST}', 'msg-1')`,
        role === "authenticated" ? CREW : undefined,
      );
    await expect(insert("authenticated")).rejects.toThrow(/permission denied/);
    await insert("service_role");
    await expect(as(db, "authenticated", `select * from public.notification_log`, CREW)).rejects.toThrow(/permission denied/);
    const r = await as(db, "service_role", `select kind, channel, to_email, provider_id, error from public.notification_log`);
    expect(r.rows).toEqual([{ kind: "rung_email", channel: "email", to_email: "robin@example.org", provider_id: "msg-1", error: null }]);
  });

  it("a deleted person leaves their log row, anonymised; a deleted post likewise", async () => {
    await db.exec(`delete from public.person where id = '${CREW}'`);
    const r = await db.query<{ person_id: string | null; post_id: string | null }>(`select person_id, post_id from public.notification_log`);
    expect(r.rows).toEqual([{ person_id: null, post_id: POST }]);
    // And the suggestion row, which is the crew's, went with them (cascade).
    expect((await db.query(`select 1 from public.suggestion`)).rows).toEqual([]);
  });
});

describe("what notifyRung() reads as service_role (0010 grants on older tables)", () => {
  it("service_role can read post, boat, race_date, person, person_contact and availability", async () => {
    for (const t of ["post", "boat", "race_date", "person", "person_contact", "availability"]) {
      const r = await db.query<{ ok: boolean }>(`select has_table_privilege('service_role', 'public.${t}', 'select') as ok`);
      expect(r.rows, t).toEqual([{ ok: true }]);
    }
    // Negative control on the instrument: a table this file grants nothing on reads false.
    const r = await db.query<{ ok: boolean }>(`select has_table_privilege('service_role', 'public.answer', 'select') as ok`);
    expect(r.rows).toEqual([{ ok: false }]);
  });
});
