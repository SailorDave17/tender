import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0008 — match, accept_answer() and the widened person_contact policy. Story #21 AC 1 and
 * AC 2: a skipper accepts one live answer on their own post through the definer function and
 * nothing else can write a match; after that the two parties — and only they — read each
 * other's contact row, as pure RLS.
 *
 * Every deny is against `authenticated` with a positive control on the same mechanism beside
 * it (see person.test.ts for why there is no anon case on a table). The anon case here is on
 * the definer function, whose execute grant is Postgres's own and so visible to pglite.
 *
 * The fixture is shared down the file: a deny that fails to throw leaves its row behind and
 * every later count reddens with it (cairn: prove-tests, the #18 cascade).
 *
 * People: two skippers with a post each, two crew, and one bystander.
 *   SKIPPER  owns BLUE MOON, posts OPEN on SUNDAY      — accepts CREW (the match under test)
 *   SKIPPER2 owns KESTREL,   posts POST2 on NEXT       — accepts CREW2 (the "different post")
 *   CREW     answers OPEN (accepted) and POST2 (withdrawn)
 *   CREW2    answers OPEN (never accepted) and POST2 (accepted)
 *   OTHER    answers nothing, owns nothing
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const SKIPPER2 = "55555555-5555-4555-8555-555555555555";
const CREW = "22222222-2222-4222-8222-222222222222";
const CREW2 = "44444444-4444-4444-8444-444444444444";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let OPEN = ""; // SKIPPER's post on SUNDAY
let POST2 = ""; // SKIPPER2's post on NEXT

const contact = (who: string) => `select person_id, email, phone from public.person_contact where person_id = '${who}'`;
const accept = (post: string, person: string) => `select public.accept_answer('${post}', '${person}')::text as id`;

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${SKIPPER2}'), ('${CREW}'), ('${CREW2}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${SKIPPER}', 'Sam', now(), 3),
      ('${SKIPPER2}', 'Sue', now(), 3),
      ('${CREW}', 'Cy', now(), 2),
      ('${CREW2}', 'Di', now(), 2),
      ('${OTHER}', 'Otto', now(), 2);
    insert into public.person_contact (person_id, email, phone) values
      ('${SKIPPER}', 'sam@hsc-crew.org', '614-555-0101'),
      ('${SKIPPER2}', 'sue@hsc-crew.org', null),
      ('${CREW}', 'cy@hsc-crew.org', '614-555-0102'),
      ('${CREW2}', 'di@hsc-crew.org', '614-555-0104'),
      ('${OTHER}', 'otto@hsc-crew.org', '614-555-0103');
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', now() + interval '7 days', 'Spring series 1', true),
      ('${NEXT}', now() + interval '14 days', 'Spring series 2', true);
    insert into public.availability (person_id, race_date_id) values
      ('${CREW}', '${SUNDAY}'), ('${CREW}', '${NEXT}'),
      ('${CREW2}', '${SUNDAY}'), ('${CREW2}', '${NEXT}');
    insert into public.boat (owner_id, name, class, default_minimum) values
      ('${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('${SKIPPER2}', 'Kestrel', 'Flying Scot', 2);
  `);
  const boats = await db.query<{ id: string; owner_id: string }>(`select id, owner_id from public.boat`);
  const blueMoon = boats.rows.find((b) => b.owner_id === SKIPPER)!.id;
  const kestrel = boats.rows.find((b) => b.owner_id === SKIPPER2)!.id;
  await db.exec(`
    insert into public.post (boat_id, race_date_id, minimum, note) values
      ('${blueMoon}', '${SUNDAY}', 2, 'Jib'),
      ('${kestrel}', '${NEXT}', 2, 'Spinnaker');
  `);
  const posts = await db.query<{ id: string; boat_id: string }>(`select id, boat_id from public.post`);
  OPEN = posts.rows.find((p) => p.boat_id === blueMoon)!.id;
  POST2 = posts.rows.find((p) => p.boat_id === kestrel)!.id;
  await db.exec(`
    insert into public.answer (post_id, person_id, withdrawn_at) values
      ('${OPEN}', '${CREW}', null),
      ('${OPEN}', '${CREW2}', null),
      ('${POST2}', '${CREW}', now()),
      ('${POST2}', '${CREW2}', null);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("match (0008) — shape and grants", () => {
  it("exists with RLS on, one match per post, skipper and crew distinct, every parent cascading", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.match'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const uniq = await db.query<{ cols: string[] }>(
      `select array_agg(a.attname order by a.attnum) as cols
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'public.match'::regclass and c.contype = 'u'`,
    );
    expect(uniq.rows).toEqual([{ cols: ["post_id"] }]);
    const fk = await db.query<{ confrelid: string; confdeltype: string }>(
      `select confrelid::regclass::text as confrelid, confdeltype from pg_constraint
        where conrelid = 'public.match'::regclass and contype = 'f' order by conname`,
    );
    expect(fk.rows).toEqual([
      { confrelid: "person", confdeltype: "c" },
      { confrelid: "post", confdeltype: "c" },
      { confrelid: "person", confdeltype: "c" },
    ]);
    const checks = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conrelid = 'public.match'::regclass and contype = 'c'`,
    );
    expect(checks.rows).toEqual([{ n: 2 }]); // status list, skipper <> crew
  });

  it("grants authenticated select by column and nothing else — no insert, update or delete", async () => {
    const cols = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'match'
        order by privilege_type, column_name`,
    );
    expect(cols.rows.map((x) => `${x.privilege_type}:${x.column_name}`)).toEqual([
      "SELECT:accepted_at",
      "SELECT:crew_id",
      "SELECT:id",
      "SELECT:post_id",
      "SELECT:skipper_id",
      "SELECT:status",
    ]);
    const control = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.table_privileges
        where grantee = current_user and table_schema = 'public' and table_name = 'match' and privilege_type = 'DELETE'`,
    );
    expect(control.rows[0].n).toBe(1); // the owner's DELETE is visible, so the empty read below means revoked
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'match'`,
    );
    expect(t.rows).toEqual([]);
  });

  it("accept_answer() runs as its definer with search_path pinned; anon may not call it, authenticated may", async () => {
    const def = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where oid = 'public.accept_answer(uuid, uuid)'::regprocedure`,
    );
    expect(def.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
    await expect(as(db, "anon", accept(OPEN, CREW))).rejects.toThrow(/permission denied for function accept_answer/);
    // Positive control: a signed-in person reaches the body — and is refused by its first check.
    await expect(as(db, "authenticated", accept(OPEN, CREW), OTHER)).rejects.toThrow(/not your post/);
  });
});

describe("match (0008) — AC 1: the skipper chooses, the engine never assigns", () => {
  const matches = () => db.query<{ n: number }>(`select count(*)::int as n from public.match`);

  it("nobody but the post's skipper can accept: a bystander and the other skipper are refused, and nothing lands", async () => {
    await expect(as(db, "authenticated", accept(OPEN, CREW), OTHER)).rejects.toThrow(/not your post/);
    await expect(as(db, "authenticated", accept(OPEN, CREW), SKIPPER2)).rejects.toThrow(/not your post/);
    await expect(as(db, "authenticated", accept(OPEN, CREW))).rejects.toThrow(/not signed in/);
    expect((await matches()).rows).toEqual([{ n: 0 }]);
  });

  it("the skipper cannot accept someone who never answered, nor a withdrawn answer", async () => {
    await expect(as(db, "authenticated", accept(OPEN, OTHER), SKIPPER)).rejects.toThrow(/no open answer/);
    await expect(as(db, "authenticated", accept(POST2, CREW), SKIPPER2)).rejects.toThrow(/no open answer/);
    expect((await matches()).rows).toEqual([{ n: 0 }]);
  });

  it("no client can insert a match directly — the function is the only route", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.match (post_id, skipper_id, crew_id) values ('${OPEN}', '${SKIPPER}', '${CREW}')`,
        SKIPPER,
      ),
    ).rejects.toThrow(/permission denied for table match/);
    expect((await matches()).rows).toEqual([{ n: 0 }]);
  });

  it("the skipper accepts a live answer: one match row, the post closed, the id returned", async () => {
    const before = await db.query<{ closed_at: string | null }>(`select closed_at from public.post where id = '${OPEN}'`);
    expect(before.rows).toEqual([{ closed_at: null }]);
    const r = await as(db, "authenticated", accept(OPEN, CREW), SKIPPER);
    expect(r.rows).toHaveLength(1);
    const id = (r.rows[0] as { id: string }).id;
    const row = await db.query<{ id: string; post_id: string; skipper_id: string; crew_id: string; status: string }>(
      `select id, post_id, skipper_id, crew_id, status from public.match`,
    );
    expect(row.rows).toEqual([{ id, post_id: OPEN, skipper_id: SKIPPER, crew_id: CREW, status: "accepted" }]);
    const after = await db.query<{ closed: boolean }>(`select closed_at is not null as closed from public.post where id = '${OPEN}'`);
    expect(after.rows).toEqual([{ closed: true }]);
  });

  it("accepting the same post again raises — even for the other answerer — and the first match stands", async () => {
    await expect(as(db, "authenticated", accept(OPEN, CREW2), SKIPPER)).rejects.toThrow(/duplicate key|match_post_id_key/);
    await expect(as(db, "authenticated", accept(OPEN, CREW), SKIPPER)).rejects.toThrow(/duplicate key|match_post_id_key/);
    const row = await db.query<{ crew_id: string }>(`select crew_id from public.match where post_id = '${OPEN}'`);
    expect(row.rows).toEqual([{ crew_id: CREW }]);
  });

  it("every signed-in person reads the match on a post they can read — the board shows a crewed boat", async () => {
    for (const viewer of [SKIPPER, CREW, CREW2, OTHER]) {
      const r = await as(db, "authenticated", `select skipper_id, crew_id from public.match where post_id = '${OPEN}'`, viewer);
      expect(r.rows, viewer).toEqual([{ skipper_id: SKIPPER, crew_id: CREW }]);
    }
  });

  it("the other skipper accepts on their own post (the second match the policy cases need)", async () => {
    const r = await as(db, "authenticated", accept(POST2, CREW2), SKIPPER2);
    expect(r.rows).toHaveLength(1);
    expect((await matches()).rows).toEqual([{ n: 2 }]);
  });
});

describe("person_contact (0008) — AC 2: self OR counterparty, as pure RLS", () => {
  it("the matched skipper reads the crew's contact, and the crew reads the skipper's (both)", async () => {
    const skipperSees = await as(db, "authenticated", contact(CREW), SKIPPER);
    expect(skipperSees.rows).toEqual([{ person_id: CREW, email: "cy@hsc-crew.org", phone: "614-555-0102" }]);
    const crewSees = await as(db, "authenticated", contact(SKIPPER), CREW);
    expect(crewSees.rows).toEqual([{ person_id: SKIPPER, email: "sam@hsc-crew.org", phone: "614-555-0101" }]);
  });

  it("a third signed-in person gets zero rows for either party", async () => {
    expect((await as(db, "authenticated", contact(SKIPPER), OTHER)).rows).toEqual([]);
    expect((await as(db, "authenticated", contact(CREW), OTHER)).rows).toEqual([]);
    // and still reads their own (self survives the widening)
    expect((await as(db, "authenticated", contact(OTHER), OTHER)).rows).toHaveLength(1);
  });

  it("an answerer who was NOT accepted still cannot read the skipper's contact, nor the skipper theirs", async () => {
    // Di answered Sam's post and Sam picked Cy.
    expect((await as(db, "authenticated", contact(SKIPPER), CREW2)).rows).toEqual([]);
    expect((await as(db, "authenticated", contact(CREW2), SKIPPER)).rows).toEqual([]);
  });

  it("a person matched on a different post cannot read this match's parties", async () => {
    // Sue is matched with Di on POST2; neither can read Sam or Cy.
    expect((await as(db, "authenticated", contact(CREW), SKIPPER2)).rows).toEqual([]);
    expect((await as(db, "authenticated", contact(SKIPPER), SKIPPER2)).rows).toEqual([]);
    expect((await as(db, "authenticated", contact(SKIPPER), CREW2)).rows).toEqual([]);
    // Positive control: their own match still opens their own counterparty.
    expect((await as(db, "authenticated", contact(SKIPPER2), CREW2)).rows).toEqual([
      { person_id: SKIPPER2, email: "sue@hsc-crew.org", phone: null },
    ]);
  });

  it("the counterparty reads the whole row the self grant allows — email and phone, nothing more", async () => {
    await expect(as(db, "authenticated", `select * from public.person_contact where person_id = '${CREW}'`, SKIPPER)).resolves.toMatchObject({
      rows: [{ person_id: CREW, email: "cy@hsc-crew.org", phone: "614-555-0102" }],
    });
    const u = await as(
      db,
      "authenticated",
      `update public.person_contact set phone = '000' where person_id = '${CREW}'`,
      SKIPPER,
    );
    expect(u.affectedRows ?? 0).toBe(0); // 0005's update policy is self-only and unchanged
  });

  it("follows the post: a match on a date unpublished later hides the match and the contact with it", async () => {
    await db.exec(`update public.race_date set published = false where id = '${SUNDAY}'`);
    expect((await as(db, "authenticated", `select id from public.match where post_id = '${OPEN}'`, OTHER)).rows).toEqual([]);
    expect((await as(db, "authenticated", contact(CREW), SKIPPER)).rows).toEqual([]);
    await db.exec(`update public.race_date set published = true where id = '${SUNDAY}'`);
    expect((await as(db, "authenticated", contact(CREW), SKIPPER)).rows).toHaveLength(1);
  });
});
