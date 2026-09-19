import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { REMOVED_MESSAGE_NOTE } from "../src/post/thread-view";
import { as, freshDb } from "./pglite";

/**
 * 0023 — moderation (story #36). The admin reads any thread and removes a message; the admin
 * suspends and lifts a person; a suspended person cannot post, answer or message.
 *
 * Every deny carries a positive control on the SAME mechanism, so a `0`, `[]` or a throw means
 * refused rather than "the statement was wrong" — the overlay's rule for every policy test. The
 * suspension denies are controlled the strongest way available: the SAME statement, by the SAME
 * person, succeeds once the suspension is lifted, so the only thing that changed is the row.
 *
 * The fixture is shared down the file (cairn: prove-tests, the #18 cascade), and the describes
 * run in order: removal, then the author's attempts on the removed row, then suspension.
 *
 * People:
 *   ADMIN    the club admin, party to no match — so every thread they read is through the new
 *            admin policy and never through 0020's party policy.
 *   SKIPPER  owns BLUE MOON, posts OPEN, matched with CREW — the thread under test.
 *   CREW     the party whose message is removed and who is later suspended.
 *   OTHER    a signed-in bystander who owns KESTREL (posts KPOST): can read the post and the
 *            match, must read no message and no suspension.
 */

const ADMIN = "99999999-9999-4999-8999-999999999999";
const SKIPPER = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SUNDAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORIGINAL = "You are a useless sailor.";
let MATCH = "";
let KEPT = ""; // SKIPPER's message, never removed
let REMOVED = ""; // CREW's message, removed by the admin
let KPOST = ""; // OTHER's post, which CREW answers
let CREW_BOAT = "";

const thread = (m: string) =>
  `select id, author_id, body, removed_at, removed_by from public.message where match_id = '${m}' order by created_at`;
const write = (author: string, body: string) =>
  `insert into public.message (match_id, author_id, body) values ('${MATCH}', '${author}', '${body}')`;
const remove = (id: string) => `select public.remove_message('${id}')`;

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ADMIN}'), ('${SKIPPER}'), ('${CREW}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${ADMIN}', 'Ada', now(), 3, true),
      ('${SKIPPER}', 'Sam', now(), 3, false),
      ('${CREW}', 'Cy', now(), 2, false),
      ('${OTHER}', 'Otto', now(), 2, false);
    insert into public.race_date (id, starts_at, title, published) values
      ('${SUNDAY}', now() + interval '7 days', 'Spring series 1', true),
      ('${NEXT}', now() + interval '14 days', 'Spring series 2', true);
    insert into public.availability (person_id, race_date_id) values
      ('${CREW}', '${SUNDAY}'), ('${CREW}', '${NEXT}');
    insert into public.boat (owner_id, name, class, default_minimum) values
      ('${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('${OTHER}', 'Kestrel', 'Flying Scot', 2),
      ('${CREW}', 'Dinghy', 'Interlake', 1);
  `);
  const boats = await db.query<{ id: string; owner_id: string }>(`select id, owner_id from public.boat`);
  const blueMoon = boats.rows.find((b) => b.owner_id === SKIPPER)!.id;
  const kestrel = boats.rows.find((b) => b.owner_id === OTHER)!.id;
  CREW_BOAT = boats.rows.find((b) => b.owner_id === CREW)!.id;
  await db.exec(`
    insert into public.post (boat_id, race_date_id, minimum) values
      ('${blueMoon}', '${SUNDAY}', 2), ('${kestrel}', '${NEXT}', 2);
  `);
  const posts = await db.query<{ id: string; boat_id: string }>(`select id, boat_id from public.post`);
  const open = posts.rows.find((p) => p.boat_id === blueMoon)!.id;
  KPOST = posts.rows.find((p) => p.boat_id === kestrel)!.id;
  // CREW answers both: OPEN (then matched) and KPOST (the answer the suspension tests work on).
  await db.exec(`
    insert into public.answer (post_id, person_id) values ('${open}', '${CREW}'), ('${KPOST}', '${CREW}');
    insert into public.match (post_id, skipper_id, crew_id) values ('${open}', '${SKIPPER}', '${CREW}');
  `);
  MATCH = (await db.query<{ id: string }>(`select id from public.match`)).rows[0]!.id;
  await db.exec(`
    insert into public.message (match_id, author_id, body, created_at) values
      ('${MATCH}', '${SKIPPER}', 'D dock, 5pm.', now() - interval '2 minutes'),
      ('${MATCH}', '${CREW}', '${ORIGINAL}', now() - interval '1 minute');
  `);
  const msgs = await db.query<{ id: string; author_id: string }>(`select id, author_id from public.message`);
  KEPT = msgs.rows.find((m) => m.author_id === SKIPPER)!.id;
  REMOVED = msgs.rows.find((m) => m.author_id === CREW)!.id;
});
afterAll(async () => {
  await db.close();
});

describe("0023 — shape and grants", () => {
  it("adds removed_by to message, select-only, and no update or delete to any client role", async () => {
    const cols = await db.query<{ p: string }>(
      `select privilege_type || ':' || column_name as p from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'message'
          and column_name in ('removed_at', 'removed_by') order by p`,
    );
    expect(cols.rows.map((r) => r.p)).toEqual(["SELECT:removed_at", "SELECT:removed_by"]);
    const table = await db.query<{ p: string }>(
      `select distinct privilege_type as p from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'message'`,
    );
    expect(table.rows).toEqual([]); // column grants only — no whole-table UPDATE or DELETE
  });

  it("grants message_removal select-only, and suspension select, insert (two columns) and delete", async () => {
    const privs = async (t: string) =>
      (
        await db.query<{ p: string }>(
          `select privilege_type || ':' || column_name as p from information_schema.column_privileges
            where grantee = 'authenticated' and table_schema = 'public' and table_name = '${t}' order by p`,
        )
      ).rows.map((r) => r.p);
    expect(await privs("message_removal")).toEqual(["SELECT:body", "SELECT:message_id", "SELECT:removed_at"]);
    expect(await privs("suspension")).toEqual([
      "INSERT:person_id",
      "INSERT:suspended_by",
      "SELECT:person_id",
      "SELECT:suspended_at",
      "SELECT:suspended_by",
    ]);
    const whole = await db.query<{ t: string; p: string }>(
      `select table_name as t, privilege_type as p from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public'
          and table_name in ('message_removal', 'suspension') order by t, p`,
    );
    expect(whole.rows).toEqual([{ t: "suspension", p: "DELETE" }]);
  });

  it("puts the suspension clause on exactly the four writes, as RESTRICTIVE policies", async () => {
    const r = await db.query<{ p: string }>(
      `select tablename || ':' || policyname || ':' || cmd || ':' || permissive as p from pg_policies
        where schemaname = 'public' and permissive = 'RESTRICTIVE' order by p`,
    );
    expect(r.rows.map((x) => x.p)).toEqual([
      "answer:answer_insert_not_suspended:INSERT:RESTRICTIVE",
      "answer:answer_update_not_suspended:UPDATE:RESTRICTIVE",
      "message:message_insert_not_suspended:INSERT:RESTRICTIVE",
      "post:post_insert_not_suspended:INSERT:RESTRICTIVE",
    ]);
  });

  it("stores exactly REMOVED_MESSAGE_NOTE as the removed body — one sentence, two homes", async () => {
    const sql = await readFile(join(process.cwd(), "supabase", "migrations", "0023_moderation.sql"), "utf8");
    const literals = [...sql.matchAll(/set body = '([^']*)'/g)].map((m) => m[1]);
    expect(literals).toEqual([REMOVED_MESSAGE_NOTE]);
  });
});

describe("0023 — the admin reads any thread (AC 1)", () => {
  it("hands the admin, a party to nothing, every message in the thread", async () => {
    const r = await as(db, "authenticated", thread(MATCH), ADMIN);
    expect(r.rows.map((x) => (x as { id: string }).id)).toEqual([KEPT, REMOVED]);
  });

  it("still gives a non-party non-admin zero rows, though they can read the match", async () => {
    // The control: OTHER reads the match (0008), so the message policies are the whole refusal.
    const visible = await as(db, "authenticated", `select id from public.match where id = '${MATCH}'`, OTHER);
    expect(visible.rows).toHaveLength(1);
    expect((await as(db, "authenticated", thread(MATCH), OTHER)).rows).toEqual([]);
  });

  it("gives the admin READ, not write: an admin message into someone else's thread is refused", async () => {
    await expect(as(db, "authenticated", write(ADMIN, "Admin here."), ADMIN)).rejects.toThrow(/row-level security/i);
    // Control: the same statement shape as a party succeeds, so the refusal is the party rule.
    await as(db, "authenticated", write(SKIPPER, "Party here."), SKIPPER);
    await db.exec(`delete from public.message where body = 'Party here.'`);
  });
});

describe("0023 — remove_message() (AC 2)", () => {
  it("refuses a non-admin with 42501 — a party included — and changes nothing", async () => {
    await expect(as(db, "authenticated", remove(REMOVED), SKIPPER)).rejects.toMatchObject({ code: "42501" });
    await expect(as(db, "authenticated", remove(REMOVED), CREW)).rejects.toMatchObject({ code: "42501" });
    const row = await db.query<{ body: string; removed_at: string | null }>(
      `select body, removed_at from public.message where id = '${REMOVED}'`,
    );
    expect(row.rows).toEqual([{ body: ORIGINAL, removed_at: null }]);
    expect((await db.query(`select 1 from public.message_removal`)).rows).toEqual([]);
  });

  it("removes as the admin: both parties read the notice, stamped with who and when", async () => {
    await as(db, "authenticated", remove(REMOVED), ADMIN);
    for (const party of [SKIPPER, CREW]) {
      const rows = (await as(db, "authenticated", thread(MATCH), party)).rows as {
        id: string;
        body: string;
        removed_at: string | null;
        removed_by: string | null;
      }[];
      const removed = rows.find((r) => r.id === REMOVED)!;
      expect(removed.body).toBe(REMOVED_MESSAGE_NOTE);
      expect(removed.removed_at).not.toBeNull();
      expect(removed.removed_by).toBe(ADMIN);
      // The neighbour is untouched: removal is one message, not the thread.
      expect(rows.find((r) => r.id === KEPT)).toMatchObject({ body: "D dock, 5pm.", removed_at: null });
    }
  });

  it("leaves the original body nowhere a party can read it, and keeps it for the admin", async () => {
    // Every column of every row the party can read in either table, as JSON — so a column added
    // later that carried the text would be caught here too.
    for (const party of [SKIPPER, CREW]) {
      const all = await as(
        db,
        "authenticated",
        `select coalesce(json_agg(m)::text, '') as j from public.message m`,
        party,
      );
      // Positive control: the same read returns the thread, so an empty string is not the pass.
      expect((all.rows[0] as { j: string }).j).toContain("D dock, 5pm.");
      expect((all.rows[0] as { j: string }).j).not.toContain(ORIGINAL);
      expect((await as(db, "authenticated", `select body from public.message_removal`, party)).rows).toEqual([]);
    }
    const kept = await as(db, "authenticated", `select message_id, body from public.message_removal`, ADMIN);
    expect(kept.rows).toEqual([{ message_id: REMOVED, body: ORIGINAL }]);
  });

  it("is idempotent: a second removal keeps the first original rather than the notice", async () => {
    await as(db, "authenticated", remove(REMOVED), ADMIN);
    const kept = await db.query<{ body: string }>(`select body from public.message_removal`);
    expect(kept.rows).toEqual([{ body: ORIGINAL }]);
  });

  it("answers P0002 for a message that does not exist", async () => {
    await expect(
      as(db, "authenticated", remove("00000000-0000-4000-8000-000000000000"), ADMIN),
    ).rejects.toMatchObject({ code: "P0002" });
  });
});

describe("0023 — the author cannot edit or restore a removed message (AC 3)", () => {
  it("refuses the author every update and delete on the removed row, and it is unchanged", async () => {
    for (const sql of [
      `update public.message set body = '${ORIGINAL}' where id = '${REMOVED}'`,
      `update public.message set removed_at = null where id = '${REMOVED}'`,
      `update public.message set removed_by = null where id = '${REMOVED}'`,
      `delete from public.message where id = '${REMOVED}'`,
    ]) {
      await expect(as(db, "authenticated", sql, CREW)).rejects.toThrow(/permission denied/i);
    }
    // Nor through the admin's function: it is admin-only, and on a removed row it does nothing.
    await expect(as(db, "authenticated", remove(REMOVED), CREW)).rejects.toMatchObject({ code: "42501" });
    const row = await db.query<{ body: string; removed_by: string }>(
      `select body, removed_by from public.message where id = '${REMOVED}'`,
    );
    expect(row.rows).toEqual([{ body: REMOVED_MESSAGE_NOTE, removed_by: ADMIN }]);
  });

  it("still lets the author read the thread and say something new — removal is not suspension", async () => {
    // Control for the refusals above: the author's session works, and the thread is open to them.
    expect((await as(db, "authenticated", thread(MATCH), CREW)).rows).toHaveLength(2);
    await as(db, "authenticated", write(CREW, "Sorry."), CREW);
    await db.exec(`delete from public.message where body = 'Sorry.'`);
  });
});

describe("0023 — suspension (AC 4)", () => {
  const suspend = (who: string, by: string) =>
    `insert into public.suspension (person_id, suspended_by) values ('${who}', '${by}')`;
  const post = () => `insert into public.post (boat_id, race_date_id, minimum) values ('${CREW_BOAT}', '${NEXT}', 1)`;
  // Functions, not strings: KPOST is set in beforeAll, after this describe body has run.
  const answerAgain = () =>
    `update public.answer set withdrawn_at = null where post_id = '${KPOST}' and person_id = '${CREW}'`;
  const withdraw = () =>
    `update public.answer set withdrawn_at = now() where post_id = '${KPOST}' and person_id = '${CREW}'`;

  it("lets only the admin suspend, and only as themselves", async () => {
    await expect(as(db, "authenticated", suspend(CREW, SKIPPER), SKIPPER)).rejects.toThrow(/row-level security/i);
    // An admin attributing the suspension to someone else is refused too.
    await expect(as(db, "authenticated", suspend(CREW, SKIPPER), ADMIN)).rejects.toThrow(/row-level security/i);
    const none = await db.query(`select 1 from public.suspension`);
    expect(none.rows).toEqual([]);
    // Control: the admin, as themselves.
    const ok = await as(db, "authenticated", suspend(CREW, ADMIN), ADMIN);
    expect(ok.affectedRows).toBe(1);
  });

  it("shows a suspension to the person and the admin, and to no other member", async () => {
    const mine = await as(db, "authenticated", `select person_id from public.suspension`, CREW);
    expect(mine.rows).toEqual([{ person_id: CREW }]);
    const admin = await as(db, "authenticated", `select person_id from public.suspension`, ADMIN);
    expect(admin.rows).toEqual([{ person_id: CREW }]);
    expect((await as(db, "authenticated", `select person_id from public.suspension`, OTHER)).rows).toEqual([]);
    const flag = async (who: string) =>
      ((await as(db, "authenticated", `select public.is_suspended() as s`, who)).rows[0] as { s: boolean }).s;
    expect(await flag(CREW)).toBe(true);
    expect(await flag(OTHER)).toBe(false);
  });

  it("refuses the suspended person a message, a post, and answering again", async () => {
    await expect(as(db, "authenticated", write(CREW, "Let me explain."), CREW)).rejects.toThrow(/row-level security/i);
    await expect(as(db, "authenticated", post(), CREW)).rejects.toThrow(/row-level security/i);
    // Withdraw first — allowed — so the re-answer below is a real re-answer and not a no-op.
    const w = await as(db, "authenticated", withdraw(), CREW);
    expect(w.affectedRows).toBe(1);
    await expect(as(db, "authenticated", answerAgain(), CREW)).rejects.toThrow(/row-level security/i);
  });

  it("refuses a first answer too, on a post they are available for", async () => {
    // A fresh post by OTHER on SUNDAY, which CREW is available for and has never answered.
    const kestrel = (await db.query<{ id: string }>(`select id from public.boat where owner_id = '${OTHER}'`)).rows[0]!.id;
    const fresh = await as(
      db,
      "authenticated",
      `insert into public.post (boat_id, race_date_id, minimum) values ('${kestrel}', '${SUNDAY}', 2) returning id`,
      OTHER,
    );
    const freshId = (fresh.rows[0] as { id: string }).id;
    const firstAnswer = `insert into public.answer (post_id, person_id) values ('${freshId}', '${CREW}')`;
    await expect(as(db, "authenticated", firstAnswer, CREW)).rejects.toThrow(/row-level security/i);
    // can_answer() says yes for this post, so the refusal above is the suspension alone.
    const can = await as(db, "authenticated", `select public.can_answer('${freshId}') as c`, CREW);
    expect((can.rows[0] as { c: boolean }).c).toBe(true);
    await db.exec(`delete from public.post where id = '${freshId}'`);
  });

  it("hides nothing already written: the suspended person's messages and answers still read", async () => {
    const t = await as(db, "authenticated", thread(MATCH), SKIPPER);
    expect(t.rows.map((r) => (r as { author_id: string }).author_id)).toContain(CREW);
    const a = await as(db, "authenticated", `select person_id from public.answer where post_id = '${KPOST}'`, OTHER);
    expect(a.rows).toEqual([{ person_id: CREW }]);
  });

  it("lets only the admin lift it", async () => {
    // A non-admin cannot even see the row, so the delete matches nothing — and the row stays.
    const miss = await as(db, "authenticated", `delete from public.suspension where person_id = '${CREW}'`, CREW);
    expect(miss.affectedRows).toBe(0);
    expect((await db.query(`select 1 from public.suspension`)).rows).toHaveLength(1);
    const lift = await as(db, "authenticated", `delete from public.suspension where person_id = '${CREW}'`, ADMIN);
    expect(lift.affectedRows).toBe(1);
  });

  it("after the lift, the very statements refused above succeed — so the row was the refusal", async () => {
    await as(db, "authenticated", write(CREW, "Let me explain."), CREW);
    expect((await as(db, "authenticated", post(), CREW)).affectedRows).toBe(1);
    expect((await as(db, "authenticated", answerAgain(), CREW)).affectedRows).toBe(1);
    await db.exec(`
      delete from public.message where body = 'Let me explain.';
      delete from public.post where boat_id = '${CREW_BOAT}';
    `);
  });
});
