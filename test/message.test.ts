import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0020 — message, its policies and its grants. Story #35 AC 1: the two parties to a match
 * select and insert, a third person gets zero rows, and an author may not attribute a message
 * to anyone but themselves.
 *
 * Every deny carries a positive control on the SAME mechanism, so a `0` or `[]` means refused
 * rather than "the query was wrong" — the rule the overlay states for every policy test here.
 * The denies are written against `authenticated`; pglite grants nothing Supabase would, so an
 * anon case on a table cannot fail here and belongs to anon-grants.test.ts (0015).
 *
 * The fixture is shared down the file, so a deny that fails to throw leaves its row behind and
 * every later count reddens with it (cairn: prove-tests, the #18 cascade). Where a test inserts
 * deliberately it cleans up after itself.
 *
 * People — two matches, so "a party" is never accidentally "the only person with a match":
 *   SKIPPER  owns BLUE MOON, posts OPEN,  matched with CREW    — the thread under test
 *   SKIPPER2 owns KESTREL,   posts POST2, matched with CREW2   — the other thread
 *   OTHER    a signed-in bystander: can read both posts and both matches (0008), and must get
 *            zero rows from every message in both threads. That is the fixture the party
 *            predicate's two halves can actually fail on.
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const SKIPPER2 = "55555555-5555-4555-8555-555555555555";
const CREW = "22222222-2222-4222-8222-222222222222";
const CREW2 = "44444444-4444-4444-8444-444444444444";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
let MATCH = ""; // SKIPPER + CREW
let MATCH2 = ""; // SKIPPER2 + CREW2

const read = (m: string) => `select id, author_id, body from public.message where match_id = '${m}' order by created_at`;
const write = (m: string, author: string, body: string) =>
  `insert into public.message (match_id, author_id, body) values ('${m}', '${author}', '${body}')`;

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
    insert into public.person_contact (person_id, email) values
      ('${SKIPPER}', 'sam@hsc-crew.org'),
      ('${SKIPPER2}', 'sue@hsc-crew.org'),
      ('${CREW}', 'cy@hsc-crew.org'),
      ('${CREW2}', 'di@hsc-crew.org'),
      ('${OTHER}', 'otto@hsc-crew.org');
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', now() + interval '7 days', 'Spring series 1', true),
      ('${NEXT}', now() + interval '14 days', 'Spring series 2', true);
    insert into public.availability (person_id, race_date_id) values
      ('${CREW}', '${SUNDAY}'), ('${CREW2}', '${NEXT}');
    insert into public.boat (owner_id, name, class, default_minimum) values
      ('${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('${SKIPPER2}', 'Kestrel', 'Flying Scot', 2);
  `);
  const boats = await db.query<{ id: string; owner_id: string }>(`select id, owner_id from public.boat`);
  const blueMoon = boats.rows.find((b) => b.owner_id === SKIPPER)!.id;
  const kestrel = boats.rows.find((b) => b.owner_id === SKIPPER2)!.id;
  await db.exec(`
    insert into public.post (boat_id, race_date_id, minimum) values
      ('${blueMoon}', '${SUNDAY}', 2), ('${kestrel}', '${NEXT}', 2);
  `);
  const posts = await db.query<{ id: string; boat_id: string }>(`select id, boat_id from public.post`);
  const open = posts.rows.find((p) => p.boat_id === blueMoon)!.id;
  const post2 = posts.rows.find((p) => p.boat_id === kestrel)!.id;
  await db.exec(`
    insert into public.answer (post_id, person_id) values ('${open}', '${CREW}'), ('${post2}', '${CREW2}');
  `);
  // The matches are written directly rather than through accept_answer(): this file is about
  // 0020's policies, and routing through the definer would make a failure here ambiguous
  // between the two migrations.
  await db.exec(`
    insert into public.match (post_id, skipper_id, crew_id) values
      ('${open}', '${SKIPPER}', '${CREW}'), ('${post2}', '${SKIPPER2}', '${CREW2}');
  `);
  const matches = await db.query<{ id: string; skipper_id: string }>(`select id, skipper_id from public.match`);
  MATCH = matches.rows.find((m) => m.skipper_id === SKIPPER)!.id;
  MATCH2 = matches.rows.find((m) => m.skipper_id === SKIPPER2)!.id;
  // One message in each thread, by the skipper, so a read has something to refuse.
  await db.exec(`
    insert into public.message (match_id, author_id, body) values
      ('${MATCH}', '${SKIPPER}', 'D dock, 5pm.'),
      ('${MATCH2}', '${SKIPPER2}', 'Bring the spinnaker.');
  `);
});
afterAll(async () => {
  await db.close();
});

describe("message (0020) — shape and grants", () => {
  it("exists with RLS on, cascades from match and person, and caps the body at 2,000", async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.message'::regclass`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);

    const fk = await db.query<{ confrelid: string; confdeltype: string }>(
      `select confrelid::regclass::text as confrelid, confdeltype from pg_constraint
        where conrelid = 'public.message'::regclass and contype = 'f' order by conname`,
    );
    expect(fk.rows).toEqual([
      { confrelid: "person", confdeltype: "c" },
      { confrelid: "match", confdeltype: "c" },
    ]);

    // The cap is the table's, not only the Server Action's: a direct POST bypasses the action.
    const tooLong = "x".repeat(2001);
    await expect(as(db, "authenticated", write(MATCH, SKIPPER, tooLong), SKIPPER)).rejects.toThrow(/violates check/i);
    // Positive control on the same mechanism: 2,000 exactly is accepted, so the refusal above
    // is the length and not the insert path.
    const ok = "y".repeat(2000);
    await as(db, "authenticated", write(MATCH, SKIPPER, ok), SKIPPER);
    await db.exec(`delete from public.message where body = '${ok}'`);

    // And an empty body is refused too — `between 1 and 2000`, not `<= 2000`.
    await expect(as(db, "authenticated", write(MATCH, SKIPPER, ""), SKIPPER)).rejects.toThrow(/violates check/i);
  });

  it("grants authenticated select on every column and insert on only the three an author supplies", async () => {
    const cols = await db.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'message'
        order by privilege_type, column_name`,
    );
    expect(cols.rows.map((x) => `${x.privilege_type}:${x.column_name}`)).toEqual([
      "INSERT:author_id",
      "INSERT:body",
      "INSERT:match_id",
      "SELECT:author_id",
      "SELECT:body",
      "SELECT:created_at",
      "SELECT:id",
      "SELECT:match_id",
      "SELECT:removed_at",
    ]);
  });

  it("grants service_role select, which the dispatcher needs and the local image does not give by default", async () => {
    const cols = await db.query<{ privilege_type: string }>(
      `select distinct privilege_type from information_schema.table_privileges
        where grantee = 'service_role' and table_schema = 'public' and table_name = 'message'
        order by privilege_type`,
    );
    expect(cols.rows.map((x) => x.privilege_type)).toEqual(["SELECT"]);
  });
});

describe("message (0020) — who reads", () => {
  it("hands each party their own thread and nothing from the other's", async () => {
    const skipper = await as(db, "authenticated", read(MATCH), SKIPPER);
    expect(skipper.rows.map((r) => (r as { body: string }).body)).toEqual(["D dock, 5pm."]);
    const crew = await as(db, "authenticated", read(MATCH), CREW);
    expect(crew.rows.map((r) => (r as { body: string }).body)).toEqual(["D dock, 5pm."]);

    // The same two people are refused the OTHER match's thread: the predicate is per match, not
    // "has a match". Without this, a policy of `exists (select 1 from match)` would pass above.
    expect((await as(db, "authenticated", read(MATCH2), SKIPPER)).rows).toEqual([]);
    expect((await as(db, "authenticated", read(MATCH2), CREW)).rows).toEqual([]);
  });

  it("gives a third signed-in person zero rows, though they can read the post and the match", async () => {
    // The control first, and it is the point of this test: OTHER can see the match itself
    // (0008's match_read_with_post). So the subquery's inner policy admits them, and the party
    // predicate is the only thing standing between them and the thread — which is what makes
    // each half of it a live clause rather than dead weight.
    const visible = await as(db, "authenticated", `select id from public.match where id = '${MATCH}'`, OTHER);
    expect(visible.rows).toHaveLength(1);

    expect((await as(db, "authenticated", read(MATCH), OTHER)).rows).toEqual([]);
    expect((await as(db, "authenticated", read(MATCH2), OTHER)).rows).toEqual([]);
  });
});

describe("message (0020) — who writes", () => {
  it("lets a party write as themselves, and both parties can", async () => {
    await as(db, "authenticated", write(MATCH, CREW, 'Works for me.'), CREW);
    await as(db, "authenticated", write(MATCH, SKIPPER, 'See you there.'), SKIPPER);
    const rows = await as(db, "authenticated", read(MATCH), CREW);
    expect(rows.rows.map((r) => (r as { body: string }).body)).toEqual(["D dock, 5pm.", "Works for me.", "See you there."]);
    await db.exec(`delete from public.message where body in ('Works for me.', 'See you there.')`);
  });

  it("refuses a message attributed to the counterparty, and the same body as themselves is accepted", async () => {
    // author_id = auth.uid() — a party may not put words in the other's mouth.
    await expect(as(db, "authenticated", write(MATCH, CREW, 'Not my words.'), SKIPPER)).rejects.toThrow(
      /row-level security/i,
    );
    // Positive control on the same statement shape: only author_id changes.
    await as(db, "authenticated", write(MATCH, SKIPPER, 'Not my words.'), SKIPPER);
    await db.exec(`delete from public.message where body = 'Not my words.'`);
  });

  it("refuses a third person writing into a thread, even honestly attributed", async () => {
    await expect(as(db, "authenticated", write(MATCH, OTHER, 'Hello?'), OTHER)).rejects.toThrow(/row-level security/i);
    // Control: OTHER is not refused everywhere — the refusal is this thread, not this person.
    // They have no match of their own, so the nearest control is that the row count is unmoved.
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.message`);
    expect(n.rows[0]?.n).toBe(2);
  });

  it("refuses a party updating or deleting a message — moderation is not a client grant", async () => {
    // No update/delete grant at all, so these fail on privilege rather than on a policy.
    await expect(
      as(db, "authenticated", `update public.message set body = 'edited' where match_id = '${MATCH}'`, SKIPPER),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      as(db, "authenticated", `delete from public.message where match_id = '${MATCH}'`, SKIPPER),
    ).rejects.toThrow(/permission denied/i);
    // Control: the same person's select on the same rows still works, so the refusals above are
    // the missing grants and not a broken session.
    expect((await as(db, "authenticated", read(MATCH), SKIPPER)).rows).toHaveLength(1);
  });
});
