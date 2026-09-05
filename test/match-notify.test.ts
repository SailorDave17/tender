import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0018 — service_role reads `match` (story #33).
 *
 * One claim, proven in both directions, the same shape as 0014's test: the read
 * notifyMatch()'s party lookup needs is granted by 0018 and by nothing earlier. The negative
 * arm boots `through: "0017"` — the world this story found — and the same statement is refused
 * there, so the positive arm's success is the file's doing rather than an inherited default
 * (the hosted project grants ALL at creation; the harness measures the files alone).
 *
 * The fixture writes the match row as the table owner: accept_answer() is the only GRANTED
 * writer, and what this file tests is the read, not the writing route (0008's own tests hold
 * that).
 */

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BOAT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const POST = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const PARTIES_SQL = `select skipper_id, crew_id from public.match where post_id = '${POST}'`;

const FIXTURE = `
  insert into public.club (name, brand_disc, brand_mark, invite_code)
    values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
  insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}');
  insert into public.person (id, display_name, adult_attested_at, rating) values
    ('${SKIPPER}', 'Sam Skipper', now(), 3), ('${CREW}', 'Robin Crew', now(), 2);
  insert into public.race_date (id, starts_at, title, published)
    values ('${DATE}', now() + interval '7 days', 'Spring Series 3', true);
  insert into public.boat (id, owner_id, name, class, default_minimum)
    values ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
  insert into public.post (id, boat_id, race_date_id, minimum) values ('${POST}', '${BOAT}', '${DATE}', 2);
  insert into public.match (post_id, skipper_id, crew_id) values ('${POST}', '${SKIPPER}', '${CREW}');
`;

let db: PGlite;
let before: PGlite;
beforeAll(async () => {
  // Sequential, not Promise.all — two concurrent boots in one file push a saturated machine
  // past harness-budget.test.ts's boot budget (measured on #24's test, 2026-08-30).
  db = await freshDb();
  before = await freshDb({ through: "0017" });
  await db.exec(FIXTURE);
  await before.exec(FIXTURE);
});
afterAll(async () => {
  await Promise.all([db.close(), before.close()]);
});

describe("0018 — the match parties' grant", () => {
  it("service_role reads the match row's two parties", async () => {
    const r = await as(db, "service_role", PARTIES_SQL);
    expect(r.rows).toEqual([{ skipper_id: SKIPPER, crew_id: CREW }]);
  });

  it("through 0017 the same statement is refused — the grant is 0018's, not inherited", async () => {
    await expect(as(before, "service_role", PARTIES_SQL)).rejects.toThrow(/permission denied/);
  });

  it("0018 grants the client roles nothing new: authenticated still reads match under 0008's policy, anon is still refused", async () => {
    // The positive control beside the deny (house rule): a signed-in person reads the match.
    const mine = await as(db, "authenticated", PARTIES_SQL, SKIPPER);
    expect(mine.rows).toEqual([{ skipper_id: SKIPPER, crew_id: CREW }]);
    await expect(as(db, "anon", PARTIES_SQL)).rejects.toThrow(/permission denied/);
  });
});
