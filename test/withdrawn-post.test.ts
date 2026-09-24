import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0034 — withdrawn_post_day() (story #199). Unpublishing a race date hides its posts from
 * everyone under 0006, the post's own skipper included; the function tells a post's own people
 * that the day was withdrawn, and tells everyone else nothing.
 *
 * AC 1: the skipper (and the post's other people) get the day back rather than nothing.
 * AC 2: a member who is not the skipper, an answerer or a match party gets NULL — the same answer
 *       as for a post that does not exist — pinned with the skipper's non-null read on the SAME
 *       post in the same test, so a NULL means "refused" and not "query wrong".
 * And the route's premise: no read policy moved. The skipper still reads zero rows of the post.
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222"; // answered the open post
const QUITTER = "33333333-3333-4333-8333-333333333333"; // answered the open post, then withdrew
const SKIPPER2 = "44444444-4444-4444-8444-444444444444";
const MATE = "55555555-5555-4555-8555-555555555555"; // matched on SKIPPER2's post
const STRANGER = "66666666-6666-4666-8666-666666666666";
const ADMIN = "77777777-7777-4777-8777-777777777777";
const LIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // stays published
const PULLED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // unpublished after its posts were made
const OPEN = "c0000000-0000-4000-8000-000000000001"; // SKIPPER's post on PULLED
const MATCHED = "c0000000-0000-4000-8000-000000000002"; // SKIPPER2's post on PULLED, matched
const ON_LIVE = "c0000000-0000-4000-8000-000000000003"; // SKIPPER's post on LIVE
const NOWHERE = "c0000000-0000-4000-8000-00000000dead";

let db: PGlite;
let pulledStartsAt = "";

const day = async (post: string, userId?: string) => {
  const r = await as(db, "authenticated", `select public.withdrawn_post_day('${post}')::text as d`, userId);
  return (r.rows[0] as { d: string | null }).d;
};

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values
      ('${SKIPPER}'), ('${CREW}'), ('${QUITTER}'), ('${SKIPPER2}'), ('${MATE}'), ('${STRANGER}'), ('${ADMIN}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${SKIPPER}', 'Sam', now(), 3, false),
      ('${CREW}', 'Cy', now(), 2, false),
      ('${QUITTER}', 'Quinn', now(), 2, false),
      ('${SKIPPER2}', 'Ann', now(), 3, false),
      ('${MATE}', 'Mo', now(), 2, false),
      ('${STRANGER}', 'Stan', now(), 2, false),
      ('${ADMIN}', 'Dave', now(), 3, true);
    insert into public.race_date (id, starts_at, title, published) values
      ('${LIVE}', now() + interval '7 days', 'Spring series 1', true),
      ('${PULLED}', now() + interval '14 days', 'Spring series 2', true);
    insert into public.boat (id, owner_id, name, class, default_minimum) values
      ('d0000000-0000-4000-8000-000000000001', '${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('d0000000-0000-4000-8000-000000000002', '${SKIPPER2}', 'Wanderer', 'Thistle', 1);
    insert into public.post (id, boat_id, race_date_id, minimum) values
      ('${OPEN}', 'd0000000-0000-4000-8000-000000000001', '${PULLED}', 2),
      ('${MATCHED}', 'd0000000-0000-4000-8000-000000000002', '${PULLED}', 1),
      ('${ON_LIVE}', 'd0000000-0000-4000-8000-000000000001', '${LIVE}', 2);
    insert into public.answer (post_id, person_id, withdrawn_at) values
      ('${OPEN}', '${CREW}', null),
      ('${OPEN}', '${QUITTER}', now()),
      ('${MATCHED}', '${MATE}', null);
    insert into public.match (post_id, skipper_id, crew_id) values ('${MATCHED}', '${SKIPPER2}', '${MATE}');
    -- #134's sequence: the posts exist on a published day, then an admin unpublishes it.
    update public.race_date set published = false where id = '${PULLED}';
  `);
  const r = await db.query<{ s: string }>(`select starts_at::text as s from public.race_date where id = '${PULLED}'`);
  pulledStartsAt = r.rows[0].s;
});
afterAll(async () => {
  await db.close();
});

describe("0034 — the hide itself is unchanged (the route widens no read)", () => {
  it("the skipper still reads zero rows of their post on the pulled day, and one on a live day", async () => {
    const pulled = await as(db, "authenticated", `select id from public.post where id = '${OPEN}'`, SKIPPER);
    const live = await as(db, "authenticated", `select id from public.post where id = '${ON_LIVE}'`, SKIPPER);
    expect(pulled.rows).toEqual([]);
    expect(live.rows).toEqual([{ id: ON_LIVE }]);
  });

  it("the match on the pulled day is hidden from both its parties, as the issue found", async () => {
    for (const who of [SKIPPER2, MATE]) {
      const m = await as(db, "authenticated", `select id from public.match where post_id = '${MATCHED}'`, who);
      expect(m.rows, who).toEqual([]);
    }
  });
});

describe("0034 — withdrawn_post_day() answers a post's own people (AC 1)", () => {
  it("gives the skipper the pulled day's start", async () => {
    expect(pulledStartsAt).not.toBe("");
    expect(await day(OPEN, SKIPPER)).toBe(pulledStartsAt);
  });

  it("gives an answerer the day, including one who withdrew their answer", async () => {
    expect(await day(OPEN, CREW)).toBe(pulledStartsAt);
    expect(await day(OPEN, QUITTER)).toBe(pulledStartsAt);
  });

  // No clause of 0034 names match: the skipper side is the boat's owner and the crew side holds an
  // answer row. This pins that both parties are still answered through those two.
  it("gives both parties to a match the day", async () => {
    expect(await day(MATCHED, SKIPPER2)).toBe(pulledStartsAt);
    expect(await day(MATCHED, MATE)).toBe(pulledStartsAt);
  });
});

describe("0034 — and nobody else (AC 2)", () => {
  it("answers NULL to a member with no part in the post, beside the skipper's answer on the same post", async () => {
    expect(await day(OPEN, SKIPPER)).toBe(pulledStartsAt); // positive control, same post
    expect(await day(OPEN, STRANGER)).toBeNull();
    expect(await day(OPEN, ADMIN)).toBeNull(); // being admin is not being one of the post's people
    expect(await day(OPEN, MATE)).toBeNull(); // a party to a DIFFERENT post on the same day
    expect(await day(MATCHED, CREW)).toBeNull();
    expect(await day(OPEN)).toBeNull(); // no user at all
  });

  it("answers the same NULL for a post that does not exist, so the two cannot be told apart", async () => {
    expect(await day(NOWHERE, SKIPPER)).toBeNull();
    expect(await day(NOWHERE, STRANGER)).toBeNull();
  });

  it("answers NULL on a published day — the post is readable there, so nothing was withdrawn", async () => {
    expect(await day(ON_LIVE, SKIPPER)).toBeNull();
  });
});

describe("0034 — grants", () => {
  it("is executable by authenticated and not by anon or PUBLIC", async () => {
    const r = await db.query<{ role: string; ok: boolean }>(
      `select r as role, has_function_privilege(r, 'public.withdrawn_post_day(uuid)', 'execute') as ok
         from unnest(array['authenticated', 'anon']) r order by r`,
    );
    expect(r.rows).toEqual([
      { role: "anon", ok: false },
      { role: "authenticated", ok: true },
    ]);
    await expect(as(db, "anon", `select public.withdrawn_post_day('${OPEN}')`)).rejects.toThrow(/permission denied/);
  });

  it("revokes execute from anon BY NAME in the file, which the catalog read above cannot prove", async () => {
    // The hosted project grants anon execute on every new function directly; this harness does
    // not, so anon's only route here is PUBLIC and `revoke … from public` alone passes the test
    // above (measured on #199's mutation pass: 0 red). The file is the instrument for the anon half.
    const sql = await readFile(fileURLToPath(new URL("../supabase/migrations/0034_withdrawn_post_day.sql", import.meta.url)), "utf8");
    const revokes = [...sql.matchAll(/revoke\s+all\s+on\s+function\s+public\.withdrawn_post_day\(uuid\)\s+from\s+([^;]+);/gi)];
    expect(revokes).toHaveLength(1);
    expect(revokes[0][1].split(",").map((r) => r.trim())).toEqual(["public", "anon"]);
  });

  it("is a definer with search_path pinned", async () => {
    const r = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select prosecdef, proconfig from pg_proc where oid = 'public.withdrawn_post_day(uuid)'::regprocedure`,
    );
    expect(r.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });
});

describe("0034 — republishing brings the post back and the answer goes quiet", () => {
  it("after republish, the skipper reads the post again and the function answers NULL", async () => {
    await db.exec(`update public.race_date set published = true where id = '${PULLED}'`);
    const back = await as(db, "authenticated", `select id from public.post where id = '${OPEN}'`, SKIPPER);
    expect(back.rows).toEqual([{ id: OPEN }]);
    expect(await day(OPEN, SKIPPER)).toBeNull();
  });
});
