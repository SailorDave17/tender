import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0014 — service_role reads `answer` (story #24).
 *
 * One claim, proven in both directions: the grant notifyAnswer()'s count needs is made by 0014
 * and by nothing earlier. The negative arm boots `through: "0013"` — every migration up to and
 * including 0013, i.e. the world this story found — and the same statement is refused there,
 * so the positive arm's success is the file's doing rather than an inherited default (the
 * hosted project grants ALL at creation; the harness measures the files alone).
 *
 * The count statement is the store's own shape (withdrawn_at null), run with a withdrawn row
 * seeded, so the arm also holds that a withdrawal leaves the N in "N crew answered".
 */

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREW2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BOAT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const POST = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const COUNT_SQL = `select count(*)::int as n from public.answer where post_id = '${POST}' and withdrawn_at is null`;

let db: PGlite;
let before: PGlite;
beforeAll(async () => {
  // Sequential, not Promise.all: this file is the only one that boots TWO pglites, and two
  // concurrent boots here measurably pushed a saturated machine past harness-budget.test.ts's
  // 20s boot budget (measured 2026-08-30, first full run of this file). Serial is ~2x this
  // file's beforeAll and well inside hookTimeout; peak load is what the budget test pays for.
  db = await freshDb();
  before = await freshDb({ through: "0013" });
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}'), ('${CREW2}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${SKIPPER}', 'Sam Skipper', now(), 3), ('${CREW}', 'Robin Crew', now(), 2),
      ('${CREW2}', 'Jo Crew', now(), 2);
    insert into public.race_date (id, starts_at, title, published)
      values ('${DATE}', now() + interval '7 days', 'Spring Series 3', true);
    insert into public.boat (id, owner_id, name, class, default_minimum)
      values ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
    insert into public.post (id, boat_id, race_date_id, minimum) values ('${POST}', '${BOAT}', '${DATE}', 2);
    insert into public.answer (post_id, person_id) values ('${POST}', '${CREW}');
    insert into public.answer (post_id, person_id, withdrawn_at) values ('${POST}', '${CREW2}', now());
  `);
});
afterAll(async () => {
  await Promise.all([db.close(), before.close()]);
});

describe("0014 — the answer count's grant", () => {
  it("service_role counts un-withdrawn answers; the withdrawn one is not in the N", async () => {
    const r = await as(db, "service_role", COUNT_SQL);
    expect(r.rows).toEqual([{ n: 1 }]);
  });

  it("through 0013 the same statement is refused — the grant is 0014's, not inherited", async () => {
    await expect(as(before, "service_role", COUNT_SQL)).rejects.toThrow(/permission denied/);
  });

  it("0014 grants the client roles nothing new: authenticated still reads answer under 0007's policy, anon is still refused", async () => {
    // The positive control beside the deny (house rule): the skipper reads answers on their post.
    const mine = await as(db, "authenticated", COUNT_SQL, SKIPPER);
    expect(mine.rows).toEqual([{ n: 1 }]);
    await expect(as(db, "anon", COUNT_SQL)).rejects.toThrow(/permission denied/);
  });
});
