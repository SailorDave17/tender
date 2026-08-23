import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0007 — answer. Story #20 AC 1: a crew inserts or withdraws only their own answer, and only
 * on an open post whose date they have marked available; the post's skipper reads every
 * answer on their post; anyone else reads only the count, through answer_counts().
 *
 * Every deny is against `authenticated` with a positive control on the same mechanism beside
 * it (see person.test.ts for why there is no anon case on a table). The one anon case here is
 * on the definer function, whose execute grant is Postgres's to make and so visible to pglite.
 *
 * The fixture is shared down the file: a deny that fails to throw leaves its row behind and
 * every later count reddens with it (cairn: prove-tests, the #18 cascade).
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222"; // available for SUNDAY and NEXT
const CREW2 = "44444444-4444-4444-8444-444444444444"; // available for nothing, at first
const OTHER = "33333333-3333-4333-8333-333333333333"; // neither skipper nor answerer
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let BOAT = "";
let OPEN = ""; // the skipper's post on SUNDAY
let CLOSED = ""; // the skipper's post on NEXT, closed

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}'), ('${CREW2}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${SKIPPER}', 'Sam', now(), 3, false),
      ('${CREW}', 'Cy', now(), 2, false),
      ('${CREW2}', 'Di', now(), 2, false),
      ('${OTHER}', 'Otto', now(), 2, false);
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', now() + interval '7 days', 'Spring series 1', true),
      ('${NEXT}', now() + interval '14 days', 'Spring series 2', true);
    insert into public.availability (person_id, race_date_id) values
      ('${CREW}', '${SUNDAY}'), ('${CREW}', '${NEXT}');
    insert into public.boat (owner_id, name, class, default_minimum)
      values ('${SKIPPER}', 'Blue Moon', 'Thistle', 2);
  `);
  const boat = await db.query<{ id: string }>(`select id from public.boat where name = 'Blue Moon'`);
  BOAT = boat.rows[0].id;
  await db.exec(`
    insert into public.post (boat_id, race_date_id, minimum, note) values ('${BOAT}', '${SUNDAY}', 2, 'Jib');
    insert into public.post (boat_id, race_date_id, minimum, note, closed_at)
      values ('${BOAT}', '${NEXT}', 2, 'Closed already', now());
  `);
  const posts = await db.query<{ id: string; race_date_id: string }>(`select id, race_date_id from public.post`);
  OPEN = posts.rows.find((p) => p.race_date_id === SUNDAY)!.id;
  CLOSED = posts.rows.find((p) => p.race_date_id === NEXT)!.id;
});
afterAll(async () => {
  await db.close();
});

describe("answer (0007) — shape and grants", () => {
  it("exists with RLS on, keyed by (post_id, person_id), withdrawn_at nullable, both parents cascade", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.answer'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const pk = await db.query<{ cols: string[] }>(
      `select array_agg(a.attname order by a.attnum) as cols
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
        where c.conrelid = 'public.answer'::regclass and c.contype = 'p'`,
    );
    expect(pk.rows).toEqual([{ cols: ["post_id", "person_id"] }]);
    const withdrawn = await db.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'answer' and column_name = 'withdrawn_at'`,
    );
    expect(withdrawn.rows).toEqual([{ is_nullable: "YES" }]);
    const fk = await db.query<{ confrelid: string; confdeltype: string }>(
      `select confrelid::regclass::text as confrelid, confdeltype from pg_constraint
        where conrelid = 'public.answer'::regclass and contype = 'f' order by confrelid`,
    );
    expect(fk.rows).toEqual([
      { confrelid: "person", confdeltype: "c" },
      { confrelid: "post", confdeltype: "c" },
    ]);
  });

  it("grants authenticated by column: insert the pair, update withdrawn_at only, no delete at all", async () => {
    const r = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'answer'
          and privilege_type in ('INSERT', 'UPDATE')
        order by privilege_type, column_name`,
    );
    expect(r.rows.map((x) => `${x.privilege_type}:${x.column_name}`)).toEqual([
      "INSERT:person_id",
      "INSERT:post_id",
      "UPDATE:withdrawn_at",
    ]);
    const t = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'answer'`,
    );
    expect(t.rows).toEqual([]); // no whole-table privilege: in particular no DELETE
  });

  it("answer_counts() runs as its definer and only authenticated may call it — anon is refused", async () => {
    const def = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where oid = 'public.answer_counts(uuid[])'::regprocedure`,
    );
    expect(def.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]); // pinned empty, as Postgres spells it
    await expect(
      as(db, "anon", `select * from public.answer_counts(array['${OPEN}']::uuid[])`),
    ).rejects.toThrow(/permission denied for function answer_counts/);
    // Positive control: the same call as a signed-in person runs (nothing answered yet).
    const ok = await as(db, "authenticated", `select * from public.answer_counts(array['${OPEN}']::uuid[])`, OTHER);
    expect(ok.rows).toEqual([]);
  });
});

describe("answer (0007) — AC 1: a crew answers, only for themselves, only where they can", () => {
  it("an available crew answers an open post (own insert ok)", async () => {
    const i = await as(
      db,
      "authenticated",
      `insert into public.answer (post_id, person_id) values ('${OPEN}', '${CREW}')`,
      CREW,
    );
    expect(i.affectedRows).toBe(1);
  });

  it("a crew cannot answer as someone else (other's insert refused), and nothing lands", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.answer (post_id, person_id) values ('${OPEN}', '${CREW2}')`,
        CREW,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.answer`);
    expect(n.rows).toEqual([{ n: 1 }]);
  });

  it("a crew who has not marked the date available is refused; marking it is what admits them", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.answer (post_id, person_id) values ('${OPEN}', '${CREW2}')`,
        CREW2,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const mark = await as(
      db,
      "authenticated",
      `insert into public.availability (person_id, race_date_id) values ('${CREW2}', '${SUNDAY}')`,
      CREW2,
    );
    expect(mark.affectedRows).toBe(1);
    // Positive control: same person, same post, now available — lands.
    const ok = await as(
      db,
      "authenticated",
      `insert into public.answer (post_id, person_id) values ('${OPEN}', '${CREW2}')`,
      CREW2,
    );
    expect(ok.affectedRows).toBe(1);
  });

  it("an answer on a closed post is refused, though the crew is available for its date", async () => {
    const avail = await as(
      db,
      "authenticated",
      `select 1 from public.availability where person_id = '${CREW}' and race_date_id = '${NEXT}'`,
      CREW,
    );
    expect(avail.rows).toHaveLength(1); // the date is not what refuses below
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.answer (post_id, person_id) values ('${CLOSED}', '${CREW}')`,
        CREW,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.answer`);
    expect(n.rows).toEqual([{ n: 2 }]);
  });

  it("can_answer() follows post's read policy: a post on a date unpublished later is no longer answerable", async () => {
    const before = await as(db, "authenticated", `select public.can_answer('${OPEN}') as v`, CREW);
    expect(before.rows).toEqual([{ v: true }]);
    const nobody = await as(db, "authenticated", `select public.can_answer('${OPEN}') as v`);
    expect(nobody.rows).toEqual([{ v: false }]);
    await db.exec(`update public.race_date set published = false where id = '${SUNDAY}'`);
    const after = await as(db, "authenticated", `select public.can_answer('${OPEN}') as v`, CREW);
    expect(after.rows).toEqual([{ v: false }]);
    await db.exec(`update public.race_date set published = true where id = '${SUNDAY}'`);
  });

  it("a client cannot choose created_at or withdraw on insert (column grant)", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.answer (post_id, person_id, created_at) values ('${OPEN}', '${OTHER}', now())`,
        OTHER,
      ),
    ).rejects.toThrow(/permission denied for table answer/);
  });
});

describe("answer (0007) — AC 1: who reads what", () => {
  it("the post's skipper reads every answer on their post", async () => {
    const r = await as(
      db,
      "authenticated",
      `select person_id from public.answer where post_id = '${OPEN}' order by created_at`,
      SKIPPER,
    );
    expect(r.rows).toEqual([{ person_id: CREW }, { person_id: CREW2 }]);
  });

  it("a crew reads their own answer and nobody else's on the same post", async () => {
    const mine = await as(db, "authenticated", `select person_id from public.answer`, CREW);
    expect(mine.rows).toEqual([{ person_id: CREW }]);
    const theirs = await as(
      db,
      "authenticated",
      `select person_id from public.answer where person_id = '${CREW2}'`,
      CREW,
    );
    expect(theirs.rows).toEqual([]);
  });

  it("a signed-in person who is neither skipper nor answerer reads zero rows — and the count", async () => {
    const rows = await as(db, "authenticated", `select person_id from public.answer`, OTHER);
    expect(rows.rows).toEqual([]);
    const counts = await as(
      db,
      "authenticated",
      `select post_id, answered from public.answer_counts(array['${OPEN}', '${CLOSED}']::uuid[])`,
      OTHER,
    );
    expect(counts.rows).toEqual([{ post_id: OPEN, answered: 2 }]); // CLOSED has none, so no row
  });
});

describe("answer (0007) — AC 1: withdrawing, and answering again", () => {
  it("a crew withdraws their own answer; the count drops; the row stays readable to the skipper", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.answer set withdrawn_at = now() where post_id = '${OPEN}' and person_id = '${CREW2}'`,
      CREW2,
    );
    expect(u.affectedRows).toBe(1);
    const counts = await as(
      db,
      "authenticated",
      `select answered from public.answer_counts(array['${OPEN}']::uuid[])`,
      OTHER,
    );
    expect(counts.rows).toEqual([{ answered: 1 }]);
    const skipper = await as(
      db,
      "authenticated",
      `select person_id, withdrawn_at is not null as withdrawn from public.answer where post_id = '${OPEN}' order by created_at`,
      SKIPPER,
    );
    expect(skipper.rows).toEqual([
      { person_id: CREW, withdrawn: false },
      { person_id: CREW2, withdrawn: true },
    ]);
  });

  it("a crew cannot withdraw someone else's answer (zero rows), nor delete any (no grant)", async () => {
    const u = await as(
      db,
      "authenticated",
      `update public.answer set withdrawn_at = now() where person_id = '${CREW}'`,
      CREW2,
    );
    expect(u.affectedRows ?? 0).toBe(0);
    await expect(as(db, "authenticated", `delete from public.answer`, CREW)).rejects.toThrow(
      /permission denied for table answer/,
    );
    const still = await db.query<{ n: number }>(
      `select count(*)::int as n from public.answer where withdrawn_at is null`,
    );
    expect(still.rows).toEqual([{ n: 1 }]);
  });

  it("answering again clears withdrawn_at — while still available; not once availability is gone", async () => {
    const again = await as(
      db,
      "authenticated",
      `update public.answer set withdrawn_at = null where post_id = '${OPEN}' and person_id = '${CREW2}'`,
      CREW2,
    );
    expect(again.affectedRows).toBe(1);
    const back = await as(
      db,
      "authenticated",
      `update public.answer set withdrawn_at = now() where post_id = '${OPEN}' and person_id = '${CREW2}'`,
      CREW2,
    );
    expect(back.affectedRows).toBe(1);
    const unmark = await as(
      db,
      "authenticated",
      `delete from public.availability where person_id = '${CREW2}' and race_date_id = '${SUNDAY}'`,
      CREW2,
    );
    expect(unmark.affectedRows).toBe(1);
    // The same update that landed above is now refused: the new row fails the policy's check.
    await expect(
      as(
        db,
        "authenticated",
        `update public.answer set withdrawn_at = null where post_id = '${OPEN}' and person_id = '${CREW2}'`,
        CREW2,
      ),
    ).rejects.toThrow(/row-level security policy/);
    const counts = await as(
      db,
      "authenticated",
      `select answered from public.answer_counts(array['${OPEN}']::uuid[])`,
      OTHER,
    );
    expect(counts.rows).toEqual([{ answered: 1 }]);
  });

  it("a crew can still withdraw on a post that has since closed", async () => {
    await db.exec(`update public.post set closed_at = now() where id = '${OPEN}'`);
    const u = await as(
      db,
      "authenticated",
      `update public.answer set withdrawn_at = now() where post_id = '${OPEN}' and person_id = '${CREW}'`,
      CREW,
    );
    expect(u.affectedRows).toBe(1);
    await db.exec(`update public.post set closed_at = null where id = '${OPEN}'`);
  });
});
