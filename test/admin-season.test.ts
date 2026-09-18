import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * Story #38 AC 4 — the admin season listing, run as real SQL against the real policies.
 *
 * ## What this test found, and why the criterion is not what it says
 *
 * AC 4 as filed reads: *the listing query run on pglite as an admin returns rows across posts,
 * matches and people; as a non-admin, zero rows.* The second half is **false against this
 * schema**, and this file is where that was measured rather than assumed.
 *
 * `post_read_published` (0006) admits every signed-in person to every post on a published date.
 * `match_read_with_post` (0008) admits a match whenever its post is readable. `person` is
 * readable by every signed-in person (0002) — deliberately, so a skipper's post can list its
 * candidates by name. **None of these three policies mentions `is_admin` at all.** They were
 * written that way on purpose: the board shows a crewed boat and both names to everyone, which
 * 0008's own header states as news the club wants public.
 *
 * So a non-admin running the listing query gets **the same rows an admin does**, and the only
 * thing standing between a crew and `/admin/dates/[id]` is the page's `notFound()`.
 *
 * That is a real answer, not a defect discovered: nothing on this screen is data a signed-in
 * member could not already read from the board and each post's page. The screen aggregates what
 * the club already publishes to its members. What it is NOT is a second, database-level refusal,
 * and the criterion claimed one.
 *
 * The tests below therefore measure what is true, in both directions, rather than asserting the
 * criterion's words:
 *
 *   1. The listing returns rows across post, match and person for an admin (the criterion's
 *      first half, which does hold).
 *   2. A non-admin reads the same rows — with the policies named, so this test reddens the day
 *      somebody narrows one and does not tell the screen.
 *   3. The things that ARE admin-only or owner-only stay refused for a non-admin: `invite_code`
 *      via `current_invite_code()`, the withheld `match.reminded_at` column, and another
 *      member's contact row. This is the positive control on the whole argument — it shows the
 *      zero-row reads in this file are refusals where a refusal exists, and not a broken query.
 *   4. An unpublished date's posts are invisible to an admin too, which is why `loadSeasonData`
 *      filters the date list to published rows.
 *
 * Every deny is written against `authenticated` with a positive control beside it, as in
 * person.test.ts; the anon sweep is test/anon-grants.test.ts's.
 *
 * The fixture is shared down the file, so a deny that fails to throw leaves its row behind and
 * every later count reddens with it (cairn: prove-tests, the #18 cascade).
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const SKIPPER = "22222222-2222-4222-8222-222222222222";
const CREW = "33333333-3333-4333-8333-333333333333";
const SAILED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRAFT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let MATCHED = ""; // SKIPPER's post on SAILED, crewed by CREW
let STRANDED = ""; // SKIPPER's second post on SAILED, nobody took it
let HIDDEN = ""; // SKIPPER's post on the unpublished date

/** The listing `loadSeasonData` issues, as one statement per table. */
const POSTS = `select id, boat_id, race_date_id, minimum, closed_at, current_rung from public.post`;
const MATCHES = `select id, post_id, skipper_id, crew_id, status from public.match`;
const PEOPLE = `select id, display_name from public.person`;
const DATES = `select id, starts_at, title, published from public.race_date where published`;

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ADMIN}'), ('${SKIPPER}'), ('${CREW}');
    insert into public.person (id, display_name, is_admin, adult_attested_at, rating) values
      ('${ADMIN}', 'Dave', true, now(), 3),
      ('${SKIPPER}', 'Sam', false, now(), 3),
      ('${CREW}', 'Cy', false, now(), 2);
    insert into public.person_contact (person_id, email, phone) values
      ('${ADMIN}', 'dave@hsc-crew.org', '614-555-0100'),
      ('${SKIPPER}', 'sam@hsc-crew.org', '614-555-0101'),
      ('${CREW}', 'cy@hsc-crew.org', '614-555-0102');
    insert into public.boat_class (name) values ('Thistle') on conflict do nothing;
    insert into public.boat (id, owner_id, name, class, default_minimum) values
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
    insert into public.race_date (id, starts_at, title, published) values
      ('${SAILED}', now() - interval '7 days', 'Spring series 1', true),
      ('${DRAFT}',  now() + interval '7 days', 'Not published yet', false);
    insert into public.availability (person_id, race_date_id) values ('${CREW}', '${SAILED}');
  `);

  const mk = async (dateId: string, rung: number) => {
    const r = await db.query<{ id: string }>(
      `insert into public.post (boat_id, race_date_id, minimum, note, current_rung)
         values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${dateId}', 2, '', ${rung})
         returning id::text as id`,
    );
    return r.rows[0].id;
  };
  // One boat may post once per date (0006's unique), so the second post needs its own boat.
  MATCHED = await mk(SAILED, 2);
  await db.exec(`
    insert into public.boat (id, owner_id, name, class, default_minimum)
      values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${SKIPPER}', 'Kestrel', 'Thistle', 2);
  `);
  const r2 = await db.query<{ id: string }>(
    `insert into public.post (boat_id, race_date_id, minimum, note, current_rung)
       values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${SAILED}', 2, '', 3)
       returning id::text as id`,
  );
  STRANDED = r2.rows[0].id;
  HIDDEN = await mk(DRAFT, 1);

  await db.exec(`
    insert into public.match (post_id, skipper_id, crew_id, status)
      values ('${MATCHED}', '${SKIPPER}', '${CREW}', 'sailed');
    update public.post set closed_at = now() where id = '${MATCHED}';
  `);
});
afterAll(async () => {
  await db.close();
});

describe("AC 4 first half — the admin's listing returns rows across posts, matches and people", () => {
  it("returns every post on a published date, with the columns the loader names", async () => {
    const r = await as(db, "authenticated", POSTS, ADMIN);
    // The two posts on the sailed date. The draft date's post is absent — see the last block.
    expect(r.rows.map((p) => (p as { id: string }).id).sort()).toEqual([MATCHED, STRANDED].sort());
  });

  it("returns the match, with the status the screen prints", async () => {
    const r = await as(db, "authenticated", MATCHES, ADMIN);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ post_id: MATCHED, crew_id: CREW, status: "sailed" });
  });

  it("returns the people the screen names", async () => {
    const r = await as(db, "authenticated", PEOPLE, ADMIN);
    expect(r.rows).toHaveLength(3);
  });

  it("returns only published dates, which is what the loader asks for", async () => {
    const r = await as(db, "authenticated", DATES, ADMIN);
    expect(r.rows.map((d) => (d as { id: string }).id)).toEqual([SAILED]);
  });
});

describe("AC 4 second half — a non-admin reads the SAME rows, and the criterion was wrong", () => {
  /**
   * Not a bug being documented: these three policies are member-wide by design (0002, 0006,
   * 0008). The value of these assertions is that they redden if somebody narrows one — at which
   * point the screen's behaviour changes and this file is where it is noticed.
   */
  it("reads the same posts as the admin — post_read_published does not mention is_admin", async () => {
    const admin = await as(db, "authenticated", POSTS, ADMIN);
    const crew = await as(db, "authenticated", POSTS, CREW);
    expect(crew.rows).toHaveLength(admin.rows.length);
    expect(crew.rows).toHaveLength(2);
  });

  it("reads the same match — match_read_with_post follows the post", async () => {
    const crew = await as(db, "authenticated", MATCHES, CREW);
    expect(crew.rows).toHaveLength(1);
    expect(crew.rows[0]).toMatchObject({ status: "sailed" });
  });

  it("reads the same people — person is readable club-wide so posts can name candidates", async () => {
    const crew = await as(db, "authenticated", PEOPLE, CREW);
    expect(crew.rows).toHaveLength(3);
  });

  it("is refused by the page, not by the database — the 404 is the only gate on this screen", async () => {
    // What the page checks. A crew reads their own is_admin as false and gets notFound().
    const r = await as(
      db,
      "authenticated",
      `select is_admin from public.person where id = '${CREW}'`,
      CREW,
    );
    expect(r.rows).toEqual([{ is_admin: false }]);
  });
});

describe("the positive control — what IS refused stays refused for a non-admin", () => {
  /**
   * Without this block the zero rows above would be indistinguishable from a broken query. Each
   * case is a refusal that really exists, measured on the same fixture and the same roles.
   */
  it("refuses a non-admin the invite code, and hands it to the admin", async () => {
    await expect(
      as(db, "authenticated", `select public.current_invite_code()`, CREW),
    ).rejects.toThrow(/42501|not an admin/i);
    const ok = await as(db, "authenticated", `select public.current_invite_code() as code`, ADMIN);
    expect(ok.rows[0]).toEqual({ code: "rotate-me" });
  });

  it("withholds match.reminded_at from every client role, admin included", async () => {
    // 0021 grants it to service_role only. The loader must never select it — a `*` would 500.
    await expect(
      as(db, "authenticated", `select reminded_at from public.match`, ADMIN),
    ).rejects.toThrow(/permission denied/i);
    // The positive control on the same table: the granted columns do come back.
    const ok = await as(db, "authenticated", `select status from public.match`, ADMIN);
    expect(ok.rows).toHaveLength(1);
  });

  it("does not hand the admin another member's contact row", async () => {
    // person_contact is self-or-counterparty (0008); being an admin is not a route to it, which
    // is why this screen names people and never emails them.
    const r = await as(
      db,
      "authenticated",
      `select person_id from public.person_contact where person_id = '${CREW}'`,
      ADMIN,
    );
    expect(r.rows).toEqual([]);
    // The control: the admin does read their own.
    const mine = await as(
      db,
      "authenticated",
      `select person_id from public.person_contact where person_id = '${ADMIN}'`,
      ADMIN,
    );
    expect(mine.rows).toHaveLength(1);
  });
});

describe("an unpublished date's posts are invisible to the admin too", () => {
  it("hides the draft date's post from the admin, which is why the loader filters to published", async () => {
    // post_read_published has no admin arm. A draft date on the season screen would render with
    // zero posts and read as "nobody posted", so loadSeasonData does not list it at all.
    const r = await as(db, "authenticated", `${POSTS} where id = '${HIDDEN}'`, ADMIN);
    expect(r.rows).toEqual([]);
    // The control: the row does exist, and the service role sees it.
    const svc = await as(db, "service_role", `${POSTS} where id = '${HIDDEN}'`);
    expect(svc.rows).toHaveLength(1);
  });
});
