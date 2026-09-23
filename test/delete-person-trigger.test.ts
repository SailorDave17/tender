import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0033 — every deletion of a person blanks their addresses in notification_log (story #201).
 *
 * Until 0033 only delete_person() blanked a leaver's to_email (0027) and push endpoints (0029).
 * person cascades from auth.users (0002), so the dashboard's Authentication → Users, a raw
 * `delete from auth.users` or GoTrue's admin API removed the person with the log rows keeping both.
 * 0033 moves the rule into a `before delete` trigger on person and takes it out of the function.
 *
 * Three routes, one person each, on one database in order, and the WHOLE log read after each so a
 * route that touched someone else's row is red too:
 *
 *   LEAVER  Lee — deleted through auth.users by a role holding select and delete on auth.users and
 *           nothing in public, which is GoTrue's shape. No call to delete_person(). AC 2's case.
 *   DEE     Dee — deletes themself through delete_person(), which no longer blanks anything itself
 *           (AC 3, owner decision: the trigger is the rule). AC 2's "still reaches the same state".
 *   SAL     Sal — deleted by service_role directly. service_role holds only select and insert on
 *           notification_log (0010), so this is the case that decides the trigger's role (AC 4):
 *           an invoker body would refuse the delete with 42501.
 *   OTHER   Otto — untouched throughout, as is an invite row, which is logged with person_id null
 *           and a real address: the trigger keys on person_id, so it cannot reach it, and there is
 *           no backfill (owner decision at pickup).
 *
 * Each person has a push row (provider_id = the device's endpoint, which goes) and an email row
 * (provider_id = Resend's message id, which stays). Rows are named by a fixed id, because
 * person_id is null on a leaver's rows afterwards.
 */

const LEAVER = "11111111-1111-4111-8111-111111111111";
const DEE = "22222222-2222-4222-8222-222222222222";
const SAL = "44444444-4444-4444-8444-444444444444";
const OTHER = "33333333-3333-4333-8333-333333333333";

const LEE_PUSH = "f2000000-0000-4000-8000-000000000001";
const LEE_EMAIL = "f2000000-0000-4000-8000-000000000002";
const DEE_PUSH = "f2000000-0000-4000-8000-000000000003";
const DEE_EMAIL = "f2000000-0000-4000-8000-000000000004";
const SAL_PUSH = "f2000000-0000-4000-8000-000000000005";
const SAL_EMAIL = "f2000000-0000-4000-8000-000000000006";
const OTTO_PUSH = "f2000000-0000-4000-8000-000000000007";
const OTTO_EMAIL = "f2000000-0000-4000-8000-000000000008";
const INVITE = "f2000000-0000-4000-8000-000000000009";

const SENT = "2026-09-01T12:00:00+00:00";

/** GoTrue's shape for the auth.users route: select and delete on auth.users, nothing in public. */
const AUTH_ADMIN = "supabase_auth_admin";

type LogRow = { id: string; person_id: string | null; to_email: string | null; provider_id: string | null };

const readLog = async (db: PGlite): Promise<LogRow[]> =>
  (await db.query<LogRow>(`select id, person_id, to_email, provider_id from public.notification_log order by id`)).rows;

const personExists = async (db: PGlite, id: string) =>
  (await db.query(`select 1 from public.person where id = '${id}'`)).rows.length === 1;

/** A person's two rows as they read before any deletion. */
const live = (push: string, email: string, person: string, name: string): LogRow[] => [
  { id: push, person_id: person, to_email: null, provider_id: `https://push.example/${name}` },
  { id: email, person_id: person, to_email: `${name}@hsc-crew.org`, provider_id: `re_${name}` },
];

/** The same two rows after the person has gone: no name, no address, no endpoint; Resend's id kept. */
const gone = (push: string, email: string, name: string): LogRow[] => [
  { id: push, person_id: null, to_email: null, provider_id: null },
  { id: email, person_id: null, to_email: null, provider_id: `re_${name}` },
];

const INVITE_ROW: LogRow = { id: INVITE, person_id: null, to_email: "newcomer@example.org", provider_id: "re_invite" };

describe("0033 — a deletion by any route blanks the person's log addresses", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    const people: [string, string, string][] = [
      [LEAVER, "Lee", "lee"],
      [DEE, "Dee", "dee"],
      [SAL, "Sal", "sal"],
      [OTHER, "Otto", "otto"],
    ];
    const rows: [string, string, string][] = [
      [LEAVER, LEE_PUSH, LEE_EMAIL],
      [DEE, DEE_PUSH, DEE_EMAIL],
      [SAL, SAL_PUSH, SAL_EMAIL],
      [OTHER, OTTO_PUSH, OTTO_EMAIL],
    ];
    const name = (id: string) => people.find(([p]) => p === id)![2];
    await db.exec(`
      insert into public.club (name, brand_disc, brand_mark, invite_code)
        values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
      insert into auth.users (id) values ${people.map(([id]) => `('${id}')`).join(", ")};
      insert into public.person (id, display_name, adult_attested_at, rating) values
        ${people.map(([id, display]) => `('${id}', '${display}', now(), 2)`).join(", ")};
      insert into public.person_contact (person_id, email) values
        ${people.map(([id, , n]) => `('${id}', '${n}@hsc-crew.org')`).join(", ")};
      insert into public.notification_log (id, kind, channel, person_id, to_email, sent_at, provider_id) values
        ${rows
          .flatMap(([person, push, email]) => [
            `('${push}', 'rung_push', 'push', '${person}', null, '${SENT}', 'https://push.example/${name(person)}')`,
            `('${email}', 'rung_email', 'email', '${person}', '${name(person)}@hsc-crew.org', '${SENT}', 're_${name(person)}')`,
          ])
          .join(",\n        ")},
        ('${INVITE}', 'invite', 'email', null, 'newcomer@example.org', '${SENT}', 're_invite');

      create role ${AUTH_ADMIN} nologin;
      grant usage on schema auth to ${AUTH_ADMIN};
      grant select, delete on auth.users to ${AUTH_ADMIN}; -- a delete's WHERE needs select on its column
    `);
  });
  afterAll(async () => {
    await db.close();
  });

  it("shape: person_blank_log is a BEFORE DELETE row trigger on person, running a definer with search_path pinned that no client role may execute", async () => {
    const trigger = await db.query<{ tgname: string; fn: string; before: boolean; row: boolean; del: boolean; enabled: string }>(
      `select t.tgname, p.proname as fn,
              (t.tgtype & 2) <> 0 as before, (t.tgtype & 1) <> 0 as row, (t.tgtype & 8) <> 0 as del,
              t.tgenabled as enabled
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'public.person'::regclass and not t.tgisinternal`,
    );
    expect(trigger.rows).toEqual([{ tgname: "person_blank_log", fn: "blank_person_log", before: true, row: true, del: true, enabled: "O" }]);

    const fn = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean }>(
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated
         from pg_proc p where p.oid = 'public.blank_person_log()'::regprocedure`,
    );
    expect(fn.rows).toEqual([{ definer: true, config: ['search_path=""'], anon: false, authenticated: false }]);
  });

  it("shape: delete_person() writes nothing to notification_log itself any more (AC 3), and kept 0027's grants", async () => {
    const def = await db.query<{ writes_log: boolean; anon: boolean; authenticated: boolean }>(
      `select position('notification_log' in pg_get_functiondef('public.delete_person(uuid)'::regprocedure)) > 0 as writes_log,
              has_function_privilege('anon', 'public.delete_person(uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.delete_person(uuid)', 'execute') as authenticated`,
    );
    expect(def.rows).toEqual([{ writes_log: false, anon: false, authenticated: true }]);
  });

  it("before any deletion, every person's rows carry an address and an endpoint — the fixture has something to lose", async () => {
    expect(await readLog(db)).toEqual([
      ...live(LEE_PUSH, LEE_EMAIL, LEAVER, "lee"),
      ...live(DEE_PUSH, DEE_EMAIL, DEE, "dee"),
      ...live(SAL_PUSH, SAL_EMAIL, SAL, "sal"),
      ...live(OTTO_PUSH, OTTO_EMAIL, OTHER, "otto"),
      INVITE_ROW,
    ]);
  });

  it("AC 2: Lee deleted through auth.users by GoTrue's role, with no call to delete_person(): the person went by cascade and so did the addresses", async () => {
    await db.exec(`set role ${AUTH_ADMIN};`);
    try {
      await db.exec(`delete from auth.users where id = '${LEAVER}';`);
    } finally {
      await db.exec(`reset role;`);
    }
    // The cascade happened — the rows below are a deleted person's, not an untouched one's.
    expect(await personExists(db, LEAVER)).toBe(false);
    expect(await readLog(db)).toEqual([
      ...gone(LEE_PUSH, LEE_EMAIL, "lee"),
      ...live(DEE_PUSH, DEE_EMAIL, DEE, "dee"),
      ...live(SAL_PUSH, SAL_EMAIL, SAL, "sal"),
      ...live(OTTO_PUSH, OTTO_EMAIL, OTHER, "otto"),
      INVITE_ROW,
    ]);
  });

  it("AC 2: Dee deletes themself through delete_person() and reaches the same state, by the trigger alone", async () => {
    await as(db, "authenticated", `select public.delete_person('${DEE}')`, DEE);
    expect(await personExists(db, DEE)).toBe(false);
    expect(await readLog(db)).toEqual([
      ...gone(LEE_PUSH, LEE_EMAIL, "lee"),
      ...gone(DEE_PUSH, DEE_EMAIL, "dee"),
      ...live(SAL_PUSH, SAL_EMAIL, SAL, "sal"),
      ...live(OTTO_PUSH, OTTO_EMAIL, OTHER, "otto"),
      INVITE_ROW,
    ]);
  });

  it("AC 4: service_role deletes Sal directly — the definer blanks a table service_role may not update, so the delete is not refused", async () => {
    // The hosted project grants service_role ALL on every public table by default (0002's header);
    // the harness deliberately does not, so the one privilege this route rests on is granted here.
    // Its negative control is the log grant itself: service_role still cannot update the log.
    await db.exec(`grant delete on public.person to service_role;`);
    const canUpdateLog = await db.query<{ ok: boolean }>(
      `select has_table_privilege('service_role', 'public.notification_log', 'update') as ok`,
    );
    expect(canUpdateLog.rows).toEqual([{ ok: false }]);

    await as(db, "service_role", `delete from public.person where id = '${SAL}'`);
    expect(await personExists(db, SAL)).toBe(false);
    expect(await readLog(db)).toEqual([
      ...gone(LEE_PUSH, LEE_EMAIL, "lee"),
      ...gone(DEE_PUSH, DEE_EMAIL, "dee"),
      ...gone(SAL_PUSH, SAL_EMAIL, "sal"),
      ...live(OTTO_PUSH, OTTO_EMAIL, OTHER, "otto"),
      INVITE_ROW,
    ]);
  });
});
