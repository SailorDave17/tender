import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0027 — delete_person() and the delete rules it rests on (story #42).
 *
 * AC 1: a person with rows in every person-keyed table and two past matches — one as crew, one
 * as skipper — deletes themself; every row of theirs is gone, both match rows remain with that
 * side null and its flag true, and a third person's call raises. Counts are taken BEFORE and
 * AFTER, per table, and the before-count is the positive control on each after-count: a `0`
 * read on a table the fixture never populated would prove nothing.
 *
 * AC 4: every security definer in the schema is re-run after the deletion. A plpgsql body
 * resolves its tables at CALL time, so a schema change that breaks one is invisible at
 * migration time and every test that does not call it (cairn:
 * a-dropped-table-does-not-drop-its-readers). The list is asserted against pg_proc first, so a
 * definer added later is red here until it is called here.
 *
 * The fixture is shared down the file and the describes run in order: shape, the denies (which
 * must leave the counts untouched), the deletion, then what still works afterwards.
 *
 * People:
 *   ADMIN    Ada — the club admin; calls the admin-only definers after the deletion, and
 *            deletes CREW2 by the admin route at the end.
 *   LEAVER   Lee — the person who leaves. Crew on M_A (Sam's boat, sailed), skipper of M_B
 *            (their own boat KESTREL, accepted, on a past date), with a row in every table.
 *   SKIPPER  Sam — owns BLUE MOON; skipper of M_A; posts P_D on a future date.
 *   CREW2    Di  — crew on M_B; answers P_D (so accept_answer has a live answer to take).
 *   OTHER    Otto — a bystander whose rows must survive untouched, and the third person whose
 *            call must raise.
 */

const ADMIN = "99999999-9999-4999-8999-999999999999";
const LEAVER = "11111111-1111-4111-8111-111111111111";
const SKIPPER = "22222222-2222-4222-8222-222222222222";
const CREW2 = "44444444-4444-4444-8444-444444444444";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PAST1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAST2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUTURE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BLUE_MOON = "b1000000-0000-4000-8000-000000000001";
const KESTREL = "b1000000-0000-4000-8000-000000000002";
const P_A = "c1000000-0000-4000-8000-00000000000a"; // Blue Moon on PAST1 — Lee crewed (M_A)
const P_B = "c1000000-0000-4000-8000-00000000000b"; // Kestrel on PAST2 — Lee skippered (M_B)
const P_C = "c1000000-0000-4000-8000-00000000000c"; // Kestrel on FUTURE — Lee's open need, KEPT
const P_D = "c1000000-0000-4000-8000-00000000000d"; // Blue Moon on FUTURE — Lee and Di answered
const M_A = "e1000000-0000-4000-8000-00000000000a";
const M_B = "e1000000-0000-4000-8000-00000000000b";
let MSG_SAM = ""; // Sam's message on M_A — survives
let MSG_LEE = ""; // Lee's message on M_A — goes

/**
 * Every table with a key onto person, the column, Lee's rows in it before the delete, and what
 * the rule does to the TABLE: a cascade removes exactly Lee's rows, a set-null keeps every row
 * and blanks the key. Both halves are asserted, because "Lee-keyed count is 0" is true of both.
 */
const LEAVER_ROWS: { table: string; where: string; before: number; rule: "cascade" | "set null" }[] = [
  { table: "person", where: `id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "person_contact", where: `person_id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "availability", where: `person_id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "answer", where: `person_id = '${LEAVER}'`, before: 2, rule: "cascade" },
  { table: "suggestion", where: `person_id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "push_subscription", where: `person_id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "message", where: `author_id = '${LEAVER}'`, before: 2, rule: "cascade" },
  { table: "suspension", where: `person_id = '${LEAVER}'`, before: 1, rule: "cascade" },
  { table: "boat", where: `owner_id = '${LEAVER}'`, before: 1, rule: "set null" },
  { table: "match", where: `skipper_id = '${LEAVER}' or crew_id = '${LEAVER}'`, before: 2, rule: "set null" },
  { table: "notification_log", where: `person_id = '${LEAVER}'`, before: 1, rule: "set null" },
];

const count = async (db: PGlite, table: string, where = "true") =>
  (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`)).rows[0]!.n;

const del = (who: string) => `select public.delete_person('${who}') as kept`;

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ADMIN}'), ('${LEAVER}'), ('${SKIPPER}'), ('${CREW2}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${ADMIN}', 'Ada', now(), 3, true),
      ('${LEAVER}', 'Lee', now(), 3, false),
      ('${SKIPPER}', 'Sam', now(), 3, false),
      ('${CREW2}', 'Di', now(), 2, false),
      ('${OTHER}', 'Otto', now(), 2, false);
    insert into public.person_contact (person_id, email, phone) values
      ('${ADMIN}', 'ada@hsc-crew.org', null),
      ('${LEAVER}', 'lee@hsc-crew.org', '614-555-0111'),
      ('${SKIPPER}', 'sam@hsc-crew.org', '614-555-0101'),
      ('${CREW2}', 'di@hsc-crew.org', null),
      ('${OTHER}', 'otto@hsc-crew.org', null);
    insert into public.race_date (id, starts_at, title, published) values
      ('${PAST1}', now() - interval '14 days', 'Spring series 1', true),
      ('${PAST2}', now() - interval '7 days', 'Spring series 2', true),
      ('${FUTURE}', now() + interval '7 days', 'Spring series 3', true);
    insert into public.availability (person_id, race_date_id) values
      ('${LEAVER}', '${FUTURE}'), ('${CREW2}', '${FUTURE}'), ('${OTHER}', '${FUTURE}');
    insert into public.boat (id, owner_id, name, class, default_minimum) values
      ('${BLUE_MOON}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('${KESTREL}', '${LEAVER}', 'Kestrel', 'Flying Scot', 2);
    insert into public.post (id, boat_id, race_date_id, minimum) values
      ('${P_A}', '${BLUE_MOON}', '${PAST1}', 2),
      ('${P_B}', '${KESTREL}', '${PAST2}', 2),
      ('${P_C}', '${KESTREL}', '${FUTURE}', 2),
      ('${P_D}', '${BLUE_MOON}', '${FUTURE}', 2);
    insert into public.answer (post_id, person_id) values
      ('${P_A}', '${LEAVER}'), ('${P_D}', '${LEAVER}'), ('${P_B}', '${CREW2}'), ('${P_D}', '${CREW2}');
    insert into public.match (id, post_id, skipper_id, crew_id, status) values
      ('${M_A}', '${P_A}', '${SKIPPER}', '${LEAVER}', 'sailed'),
      ('${M_B}', '${P_B}', '${LEAVER}', '${CREW2}', 'accepted');
    insert into public.suggestion (post_id, person_id, rung) values ('${P_D}', '${LEAVER}', 1), ('${P_D}', '${CREW2}', 1);
    insert into public.push_subscription (person_id, endpoint, p256dh, auth) values
      ('${LEAVER}', 'https://push.example/lee', 'k', 'a'), ('${OTHER}', 'https://push.example/otto', 'k', 'a');
    insert into public.message (match_id, author_id, body, created_at) values
      ('${M_A}', '${SKIPPER}', 'D dock, 5pm.', now() - interval '20 days'),
      ('${M_A}', '${LEAVER}', 'See you there.', now() - interval '20 days' + interval '1 minute'),
      ('${M_B}', '${LEAVER}', 'Bring a jacket.', now() - interval '9 days');
    insert into public.suspension (person_id, suspended_by) values ('${LEAVER}', '${ADMIN}');
    insert into public.notification_log (kind, channel, person_id, to_email, post_id) values
      ('match', 'email', '${LEAVER}', 'lee@hsc-crew.org', '${P_A}'),
      ('match', 'email', '${SKIPPER}', 'sam@hsc-crew.org', '${P_A}');
  `);
  const msgs = await db.query<{ id: string; author_id: string }>(`select id, author_id from public.message where match_id = '${M_A}'`);
  MSG_SAM = msgs.rows.find((m) => m.author_id === SKIPPER)!.id;
  MSG_LEE = msgs.rows.find((m) => m.author_id === LEAVER)!.id;
});
afterAll(async () => {
  await db.close();
});

// The counts every other describe compares against — read once the fixture is in.
const before = {
  postsByDate: new Map<string, number>(),
  matchesByDate: new Map<string, number>(),
  messagesOnA: 0,
  answersOnD: 0,
  others: new Map<string, number>(),
};

describe("0027 — shape", () => {
  it("every foreign key onto person carries the rule the migration header states", async () => {
    const rules = await db.query<{ ref: string; rule: string }>(
      `select c.conrelid::regclass::text || '.' || a.attname as ref, c.confdeltype as rule
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.contype = 'f' and c.confrelid = 'public.person'::regclass
        order by ref`,
    );
    expect(rules.rows.map((r) => `${r.ref}:${r.rule}`)).toEqual([
      "answer.person_id:c",
      "availability.person_id:c",
      "boat.owner_id:n", // 0027 — was c
      "match.crew_id:n", // 0027 — was c
      "match.skipper_id:n", // 0027 — was c
      "message.author_id:c",
      "message.removed_by:n",
      "notification_log.person_id:n",
      "person_contact.person_id:c",
      "push_subscription.person_id:c",
      "suggestion.person_id:c",
      "suspension.person_id:c",
      "suspension.suspended_by:n",
    ]);
  });

  it("match's two sides and boat.owner_id are nullable; the flags are generated over them and granted for select", async () => {
    const cols = await db.query<{ t: string; c: string; nullable: string; generated: string }>(
      `select table_name as t, column_name as c, is_nullable as nullable, is_generated as generated
         from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'match' and column_name in ('skipper_id', 'crew_id', 'skipper_anonymised', 'crew_anonymised'))
            or (table_name = 'boat' and column_name = 'owner_id'))
        order by t, c`,
    );
    // The flags are `not null` as well as generated: `x is null` is never null, and saying so
    // lets a reader type them as boolean rather than boolean-or-null.
    expect(cols.rows).toEqual([
      { t: "boat", c: "owner_id", nullable: "YES", generated: "NEVER" },
      { t: "match", c: "crew_anonymised", nullable: "NO", generated: "ALWAYS" },
      { t: "match", c: "crew_id", nullable: "YES", generated: "NEVER" },
      { t: "match", c: "skipper_anonymised", nullable: "NO", generated: "ALWAYS" },
      { t: "match", c: "skipper_id", nullable: "YES", generated: "NEVER" },
    ]);
    // A member reads the flags with the match (0008 grants by column, so this line is 0027's).
    const seen = await as(db, "authenticated", `select id, skipper_anonymised, crew_anonymised from public.match order by id`, OTHER);
    expect(seen.rows).toEqual([
      { id: M_A, skipper_anonymised: false, crew_anonymised: false },
      { id: M_B, skipper_anonymised: false, crew_anonymised: false },
    ]);
  });

  it("delete_person() is a definer with search_path pinned; anon may not call it, authenticated may", async () => {
    const def = await db.query<{ prosecdef: boolean; proconfig: string[]; prorettype: string }>(
      `select prosecdef, proconfig, prorettype::regtype::text as prorettype from pg_proc
        where oid = 'public.delete_person(uuid)'::regprocedure`,
    );
    expect(def.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'], prorettype: "integer" }]);
    const grants = await db.query<{ anon: boolean; authenticated: boolean; pub: boolean }>(
      `select has_function_privilege('anon', 'public.delete_person(uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.delete_person(uuid)', 'execute') as authenticated,
              has_function_privilege('public.delete_person(uuid)', 'execute') as pub`,
    );
    // The third is the CURRENT user's (the owner) — a positive control that the read works.
    expect(grants.rows).toEqual([{ anon: false, authenticated: true, pub: true }]);
  });
});

describe("0027 — who may delete whom (the denies leave every count alone)", () => {
  it("records the fixture's counts, and every table Lee is in has rows to lose", async () => {
    for (const r of LEAVER_ROWS) {
      expect(await count(db, r.table, r.where), `${r.table} before`).toBe(r.before);
      before.others.set(r.table, await count(db, r.table));
    }
    for (const d of [PAST1, PAST2, FUTURE]) {
      before.postsByDate.set(d, await count(db, "post", `race_date_id = '${d}'`));
      before.matchesByDate.set(d, await count(db, "match", `post_id in (select id from public.post where race_date_id = '${d}')`));
    }
    before.messagesOnA = await count(db, "message", `match_id = '${M_A}'`);
    before.answersOnD = await count(db, "answer", `post_id = '${P_D}'`);
    expect([...before.postsByDate.values()]).toEqual([1, 1, 2]);
    expect([...before.matchesByDate.values()]).toEqual([1, 1, 0]);
  });

  it("a third person is refused with 42501, and nothing moved", async () => {
    await expect(as(db, "authenticated", del(LEAVER), OTHER)).rejects.toMatchObject({ code: "42501" });
    await expect(as(db, "authenticated", del(SKIPPER), CREW2)).rejects.toMatchObject({ code: "42501" });
    for (const r of LEAVER_ROWS) expect(await count(db, r.table), `${r.table} after a deny`).toBe(before.others.get(r.table));
  });

  it("anon is refused at the grant, before the body runs", async () => {
    await expect(as(db, "anon", del(LEAVER))).rejects.toMatchObject({ code: "42501" });
  });

  it("nobody may delete a person who does not exist — an admin gets no_data_found, a stranger 42501", async () => {
    const nobody = "00000000-0000-4000-8000-000000000000";
    await expect(as(db, "authenticated", del(nobody), ADMIN)).rejects.toMatchObject({ code: "P0002" });
    await expect(as(db, "authenticated", del(nobody), OTHER)).rejects.toMatchObject({ code: "42501" });
  });

  it("no client role may delete from person directly — the function is the only route", async () => {
    await expect(as(db, "authenticated", `delete from public.person where id = '${LEAVER}'`, LEAVER)).rejects.toMatchObject({ code: "42501" });
    expect(await count(db, "person", `id = '${LEAVER}'`)).toBe(1);
  });
});

describe("0027 — AC 1: the person deletes themself", () => {
  it("returns the number of matches kept, and every row of theirs is gone while everyone else's stays", async () => {
    const r = await as(db, "authenticated", del(LEAVER), LEAVER);
    expect(r.rows).toEqual([{ kept: 2 }]);

    for (const row of LEAVER_ROWS) {
      expect(await count(db, row.table, row.where), `${row.table} rows keyed to Lee after`).toBe(0);
      // A cascade took exactly Lee's rows and no more; a set-null took none — the rows stand
      // with the key blanked (match and boat are read by their sides below).
      const lost = row.rule === "cascade" ? row.before : 0;
      expect(await count(db, row.table), `${row.table} total after`).toBe(before.others.get(row.table)! - lost);
    }
    // The bystanders' rows, by name.
    expect(await count(db, "person_contact", `person_id in ('${ADMIN}', '${SKIPPER}', '${CREW2}', '${OTHER}')`)).toBe(4);
    expect(await count(db, "push_subscription", `person_id = '${OTHER}'`)).toBe(1);
    expect(await count(db, "availability", `person_id in ('${CREW2}', '${OTHER}')`)).toBe(2);
  });

  it("both matches remain, that side null and its flag true, the other side intact", async () => {
    const m = await db.query<{ id: string; skipper_id: string | null; crew_id: string | null; sa: boolean; ca: boolean; status: string }>(
      `select id, skipper_id, crew_id, skipper_anonymised as sa, crew_anonymised as ca, status from public.match order by id`,
    );
    expect(m.rows).toEqual([
      { id: M_A, skipper_id: SKIPPER, crew_id: null, sa: false, ca: true, status: "sailed" },
      { id: M_B, skipper_id: null, crew_id: CREW2, sa: true, ca: false, status: "accepted" },
    ]);
  });

  it("the boat, its posts and the per-day counts are unchanged; only Lee's boat lost its owner", async () => {
    const boats = await db.query<{ id: string; owner_id: string | null }>(`select id, owner_id from public.boat order by id`);
    expect(boats.rows).toEqual([
      { id: BLUE_MOON, owner_id: SKIPPER },
      { id: KESTREL, owner_id: null },
    ]);
    for (const d of [PAST1, PAST2, FUTURE]) {
      expect(await count(db, "post", `race_date_id = '${d}'`), `posts on ${d}`).toBe(before.postsByDate.get(d));
      expect(
        await count(db, "match", `post_id in (select id from public.post where race_date_id = '${d}')`),
        `matches on ${d}`,
      ).toBe(before.matchesByDate.get(d));
    }
    // Lee's future need is kept (owner decision at pickup), open, and answerable by nobody's
    // acceptance: accept_answer joins boat on owner_id = auth.uid(), which null never meets.
    expect(await count(db, "post", `id = '${P_C}' and closed_at is null`)).toBe(1);
  });

  it("the counterparty's messages survive, Lee's are gone, and the notification row is kept nameless", async () => {
    expect(await count(db, "message", `match_id = '${M_A}'`)).toBe(before.messagesOnA - 1);
    expect(await count(db, "message", `id = '${MSG_SAM}'`)).toBe(1);
    expect(await count(db, "message", `id = '${MSG_LEE}'`)).toBe(0);
    const log = await db.query<{ person_id: string | null; to_email: string | null }>(
      `select person_id, to_email from public.notification_log where post_id = '${P_A}' order by to_email nulls first`,
    );
    // 0010's rule: the row stays and person_id goes null. 0027's: the ADDRESS goes too — it is
    // the person's email, and a deletion that kept it in a log would not be one (since 0033 by
    // the person_blank_log trigger, not by delete_person's own statement). Sam's row, the
    // positive control, keeps both.
    expect(log.rows).toEqual([
      { person_id: null, to_email: null },
      { person_id: SKIPPER, to_email: "sam@hsc-crew.org" },
    ]);
  });

  it("the PII went by the function's own statement, not only by cascade: the row was counted and is gone", async () => {
    // The explicit delete is the header's claim; the cascade would have produced the same
    // state, so the instrument for "explicit" is the mutation pass (drop the statement, then
    // re-point 0002's key — nothing red means the claim is cascade-only). What this asserts is
    // the outcome both routes must reach.
    expect(await count(db, "person_contact", `person_id = '${LEAVER}'`)).toBe(0);
  });
});

describe("0027 — what a member sees afterwards (the data half of AC 3)", () => {
  it("every signed-in person still reads both matches, with the flags saying which side left", async () => {
    const seen = await as(db, "authenticated", `select id, skipper_anonymised, crew_anonymised from public.match order by id`, OTHER);
    expect(seen.rows).toEqual([
      { id: M_A, skipper_anonymised: false, crew_anonymised: true },
      { id: M_B, skipper_anonymised: true, crew_anonymised: false },
    ]);
  });

  it("the surviving party reads no contact row for the side that left, and still their own", async () => {
    const sam = await as(db, "authenticated", `select person_id from public.person_contact order by person_id`, SKIPPER);
    expect(sam.rows).toEqual([{ person_id: SKIPPER }]);
    const di = await as(db, "authenticated", `select person_id from public.person_contact order by person_id`, CREW2);
    expect(di.rows).toEqual([{ person_id: CREW2 }]);
  });

  it("the surviving party still reads the thread, with the leaver's messages gone", async () => {
    const thread = await as(db, "authenticated", `select author_id from public.message where match_id = '${M_A}' order by created_at`, SKIPPER);
    expect(thread.rows).toEqual([{ author_id: SKIPPER }]);
  });
});

describe("0027 — AC 4: every security definer runs after the deletion", () => {
  it("the definers are exactly these, so one added later must be called here too", async () => {
    const definers = await db.query<{ fn: string }>(
      `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by fn`,
    );
    expect(definers.rows.map((r) => r.fn)).toEqual([
      "accept_answer",
      "admin_from_club",
      "admin_from_contact",
      "answer_counts",
      "blank_person_log", // 0033 — a trigger; called by Di's deletion at the end of this file
      "current_invite_code",
      "delete_person",
      "email_usage",
      "members_among",
      "push_install_status",
      "remove_message",
      "rotate_invite_code",
      "set_club_theme",
      "set_match_status",
    ]);
  });

  it("set_club_theme: the admin still sets the pair after the deletion, and it lands on the row", async () => {
    // 0028 reads person.is_admin through is_admin() and writes club only; a deleted member is
    // nowhere in its path, so this is the proof that it is not — read back rather than assumed.
    await as(db, "authenticated", `select public.set_club_theme('#000000', '#FFFFFF')`, ADMIN);
    const theme = await db.query<{ brand_disc: string; brand_mark: string }>(`select brand_disc, brand_mark from public.club`);
    expect(theme.rows).toEqual([{ brand_disc: "#000000", brand_mark: "#FFFFFF" }]);
  });

  it("accept_answer: Sam accepts Di on the post Lee also answered — the leaver's answer is gone, the live one is taken", async () => {
    expect(await count(db, "answer", `post_id = '${P_D}'`)).toBe(before.answersOnD - 1);
    const r = await as(db, "authenticated", `select public.accept_answer('${P_D}', '${CREW2}')::text as id`, SKIPPER);
    expect(r.rows).toHaveLength(1);
    expect(await count(db, "match", `post_id = '${P_D}' and skipper_id = '${SKIPPER}' and crew_id = '${CREW2}'`)).toBe(1);
  });

  it("admin_from_club and admin_from_contact: the triggers fire on a new member and on the club row", async () => {
    // A new person whose contact address is the club's admin_email becomes admin by trigger (0009).
    const NEW = "55555555-5555-4555-8555-555555555555";
    await db.exec(`
      update public.club set admin_email = 'new@hsc-crew.org';
      insert into auth.users (id) values ('${NEW}');
      insert into public.person (id, display_name, adult_attested_at) values ('${NEW}', 'Newbie', now());
      insert into public.person_contact (person_id, email) values ('${NEW}', 'new@hsc-crew.org');
    `);
    expect(await count(db, "person", `id = '${NEW}' and is_admin`)).toBe(1);
  });

  it("answer_counts, current_invite_code, rotate_invite_code, email_usage, members_among, push_install_status", async () => {
    const counts = await as(db, "authenticated", `select * from public.answer_counts(array['${P_D}']::uuid[])`, OTHER);
    expect(counts.rows).toEqual([{ post_id: P_D, answered: 1 }]);
    const code = await as(db, "authenticated", `select public.current_invite_code() as code`, ADMIN);
    expect(code.rows).toEqual([{ code: "rotate-me" }]);
    const rotated = await as(db, "authenticated", `select public.rotate_invite_code() as code`, ADMIN);
    expect(rotated.rows[0]).toHaveProperty("code");
    const usage = await as(
      db,
      "authenticated",
      `select * from public.email_usage(array['match']::text[], now() - interval '1 day', now() - interval '30 days')`,
      ADMIN,
    );
    expect(usage.rows).toHaveLength(1);
    const members = await as(db, "service_role", `select * from public.members_among(array['sam@hsc-crew.org', 'lee@hsc-crew.org']::text[])`);
    expect(members.rows.map((r) => Object.values(r as Record<string, unknown>)[0])).toEqual(["sam@hsc-crew.org"]); // Lee's address is gone
    const push = await as(db, "authenticated", `select * from public.push_install_status()`, ADMIN);
    expect(push.rows.some((r) => (r as { person_id: string }).person_id === LEAVER)).toBe(false);
  });

  it("remove_message: the admin removes the surviving party's message on the anonymised match", async () => {
    await as(db, "authenticated", `select public.remove_message('${MSG_SAM}')`, ADMIN);
    expect(await count(db, "message", `id = '${MSG_SAM}' and removed_at is not null`)).toBe(1);
  });

  it("set_match_status: a null side is REFUSED, not waved through — the party checks are null-safe", async () => {
    // M_B's skipper left. 0021's `v_caller <> v_match.skipper_id` is NULL against a null side,
    // which an `if` reads as "do not raise": Di could have recorded herself as sailed. 0027's
    // `is distinct from` refuses her with 42501, as it refuses any non-skipper.
    await expect(as(db, "authenticated", `select public.set_match_status('${M_B}', 'sailed')`, CREW2)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(as(db, "authenticated", `select public.set_match_status('${M_B}', 'sailed')`, OTHER)).rejects.toMatchObject({
      code: "42501",
    });
    expect(await count(db, "match", `id = '${M_B}' and status = 'accepted'`)).toBe(1);
    // The crew line, on M_A (crew left, race sailed): a bystander's `confirmed` must be refused
    // as the wrong PARTY (42501). With `<>` the party check is skipped and the date check
    // refuses instead (P0001) — a refusal for the wrong reason, which is the hole.
    await expect(as(db, "authenticated", `select public.set_match_status('${M_A}', 'confirmed')`, OTHER)).rejects.toMatchObject({
      code: "42501",
    });
    // Positive control on the same function after the deletion: the surviving skipper's
    // same-value write on the sailed match is the no-op 0021 defines, returning the prior status.
    const r = await as(db, "authenticated", `select public.set_match_status('${M_A}', 'sailed') as prior`, SKIPPER);
    expect(r.rows).toEqual([{ prior: "sailed" }]);
  });

  it("delete_person by the admin route: Di goes too, and M_B stands with both sides null", async () => {
    // blank_person_log (0033) runs on this delete, after Lee's: a row naming Di loses its address.
    await db.exec(`insert into public.notification_log (kind, channel, person_id, to_email) values ('match', 'email', '${CREW2}', 'di@hsc-crew.org')`);
    const r = await as(db, "authenticated", del(CREW2), ADMIN);
    expect(r.rows).toEqual([{ kept: 2 }]); // M_B and the match accept_answer just made on P_D
    const m = await db.query<{ id: string; skipper_id: string | null; crew_id: string | null; sa: boolean; ca: boolean }>(
      `select id, skipper_id, crew_id, skipper_anonymised as sa, crew_anonymised as ca from public.match where id = '${M_B}'`,
    );
    expect(m.rows).toEqual([{ id: M_B, skipper_id: null, crew_id: null, sa: true, ca: true }]);
    expect(await count(db, "person", `id = '${CREW2}'`)).toBe(0);
    expect(await count(db, "notification_log", `to_email = 'di@hsc-crew.org'`)).toBe(0);
  });
});
