import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { localDate } from "@/dates/race-date";
import { as, freshDb } from "./pglite";

/**
 * 0021 — the match state machine and set_match_status() (story #37 AC 1). Every refusal is a
 * pglite case: the wrong party, the wrong time, an illegal transition; and every deny sits
 * beside a positive control on the same mechanism, so a `rejects` means *refused* rather than
 * *the call was wrong*.
 *
 * TIME. The definer reads now(), so the fixtures are built RELATIVE TO TODAY IN OHIO, computed
 * in SQL from the same zone literal the function uses — a race at 23:59:59 local today (race
 * day, not started), one at 00:00:01 local today (race day, started), one tomorrow at noon, one
 * yesterday at noon. Each is unflaky except inside the one second either side of local
 * midnight, which is stated rather than hidden. The BOUNDARY itself — 23:59:59 the night before
 * refused, 00:00:00 allowed, on both sides of a DST change — is proven at pinned instants
 * against on_race_day() directly, and on_race_day() is held equal to the TypeScript `localDate`
 * rule over the same instants, because the two are two spellings of one rule and the pages
 * decide from the second what the database decides from the first.
 *
 * The fixture is shared down the file: a deny that fails to throw moves a status, and every
 * later assertion about that match reddens with it.
 */

const SKIPPER = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const BOAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Race dates, each relative to today in the club's zone (see the module docstring). */
const RACES = {
  /** Today, 23:59:59 local: race day, not yet started. */
  todayLate: { date: "c0000000-0000-4000-8000-000000000001", post: "b0000000-0000-4000-8000-000000000001", match: "e0000000-0000-4000-8000-000000000001", at: `date_trunc('day', now() at time zone 'America/New_York') + interval '23 hours 59 minutes 59 seconds'` },
  /** Today, 00:00:01 local: race day, started. */
  todayEarly: { date: "c0000000-0000-4000-8000-000000000002", post: "b0000000-0000-4000-8000-000000000002", match: "e0000000-0000-4000-8000-000000000002", at: `date_trunc('day', now() at time zone 'America/New_York') + interval '1 second'` },
  /** Tomorrow noon local: before 00:00 on the race day. */
  tomorrow: { date: "c0000000-0000-4000-8000-000000000003", post: "b0000000-0000-4000-8000-000000000003", match: "e0000000-0000-4000-8000-000000000003", at: `date_trunc('day', now() at time zone 'America/New_York') + interval '1 day 12 hours'` },
  /** Yesterday noon local: the day after the race, started. */
  yesterday: { date: "c0000000-0000-4000-8000-000000000004", post: "b0000000-0000-4000-8000-000000000004", match: "e0000000-0000-4000-8000-000000000004", at: `date_trunc('day', now() at time zone 'America/New_York') - interval '12 hours'` },
  /** Yesterday 1 pm local: a second started race, for the accepted → sailed shortcut. */
  yesterday2: { date: "c0000000-0000-4000-8000-000000000005", post: "b0000000-0000-4000-8000-000000000005", match: "e0000000-0000-4000-8000-000000000005", at: `date_trunc('day', now() at time zone 'America/New_York') - interval '11 hours'` },
};

const set = (match: string, status: string) => `select public.set_match_status('${match}', '${status}') as status`;
const statusOf = async (match: string) => (await db.query<{ status: string }>(`select status from public.match where id = '${match}'`)).rows[0].status;

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${SKIPPER}', 'Sam', now(), 3), ('${CREW}', 'Cy', now(), 2), ('${OTHER}', 'Otto', now(), 2);
    insert into public.boat (id, owner_id, name, class, default_minimum) values ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
  `);
  for (const r of Object.values(RACES)) {
    // `published` and the past-date rule are 0004's business, not this file's: the rows are
    // written as the owner, and the expression is interpreted in the club's zone.
    await db.exec(`
      insert into public.race_date (id, starts_at, title, published)
        values ('${r.date}', (${r.at}) at time zone 'America/New_York', 'Series', true);
      insert into public.post (id, boat_id, race_date_id, minimum, closed_at) values ('${r.post}', '${BOAT}', '${r.date}', 2, now());
      insert into public.match (id, post_id, skipper_id, crew_id) values ('${r.match}', '${r.post}', '${SKIPPER}', '${CREW}');
    `);
  }
});
afterAll(async () => {
  await db.close();
});

describe("0021 — shape", () => {
  it("adds reminded_at, the transition trigger, and two definer-or-stable functions with search_path pinned", async () => {
    const col = await db.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'match' and column_name = 'reminded_at'`,
    );
    expect(col.rows).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
    const trg = await db.query<{ tgname: string; tgtype: number }>(
      `select tgname, tgtype from pg_trigger where tgrelid = 'public.match'::regclass and not tgisinternal`,
    );
    expect(trg.rows.map((t) => t.tgname)).toEqual(["match_status_transition"]);
    const fns = await db.query<{ proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] }>(
      `select proname, prosecdef, provolatile, proconfig from pg_proc
        where oid in ('public.set_match_status(uuid, text)'::regprocedure, 'public.on_race_day(timestamptz, timestamptz)'::regprocedure)
        order by proname`,
    );
    expect(fns.rows).toEqual([
      { proname: "on_race_day", prosecdef: false, provolatile: "s", proconfig: ['search_path=""'] },
      { proname: "set_match_status", prosecdef: true, provolatile: "v", proconfig: ['search_path=""'] },
    ]);
  });

  it("anon may not call set_match_status; authenticated may, and is refused by its first check when not a party", async () => {
    await expect(as(db, "anon", set(RACES.todayLate.match, "confirmed"))).rejects.toThrow(/permission denied for function set_match_status/);
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "confirmed"))).rejects.toThrow(/not signed in/);
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "confirmed"), OTHER)).rejects.toThrow(/only the crew confirms/);
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "sailed"), OTHER)).rejects.toThrow(/only the skipper/);
  });

  it("refuses a status that is not one of the three, and a match that does not exist", async () => {
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "accepted"), CREW)).rejects.toThrow(/no such status/);
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "ghosted"), CREW)).rejects.toThrow(/no such status/);
    await expect(as(db, "authenticated", set("00000000-0000-4000-8000-000000000000", "confirmed"), CREW)).rejects.toThrow(/not your match/);
    expect(await statusOf(RACES.todayLate.match)).toBe("accepted");
  });
});

describe("on_race_day — the boundary, at pinned instants, both sides of a DST change", () => {
  const onRaceDay = async (race: string, moment: string) =>
    (await db.query<{ v: boolean }>(`select public.on_race_day('${race}'::timestamptz, '${moment}'::timestamptz) as v`)).rows[0].v;

  it("June (EDT): 23:59:59 the night before is not the day; 00:00:00 is; 23:59:59 that night is; the next 00:00:00 is not", async () => {
    const race = "2027-06-13T17:00:00Z";
    expect(await onRaceDay(race, "2027-06-13T03:59:59Z")).toBe(false);
    expect(await onRaceDay(race, "2027-06-13T04:00:00Z")).toBe(true);
    expect(await onRaceDay(race, "2027-06-14T03:59:59Z")).toBe(true);
    expect(await onRaceDay(race, "2027-06-14T04:00:00Z")).toBe(false);
  });

  it("November, the day the clocks go back (EST after 02:00): the day ends at 05:00Z, not 04:00Z", async () => {
    const race = "2027-11-07T18:00:00Z";
    expect(await onRaceDay(race, "2027-11-07T03:59:59Z")).toBe(false); // 23:59:59 EDT Saturday
    expect(await onRaceDay(race, "2027-11-07T04:00:00Z")).toBe(true); // 00:00 EDT Sunday
    expect(await onRaceDay(race, "2027-11-08T04:59:59Z")).toBe(true); // 23:59:59 EST Sunday
    expect(await onRaceDay(race, "2027-11-08T05:00:00Z")).toBe(false); // 00:00 EST Monday
  });

  it("agrees with the TypeScript rule the pages decide from, on every instant above and the March change", async () => {
    const instants = [
      ["2027-06-13T17:00:00Z", "2027-06-13T03:59:59Z"],
      ["2027-06-13T17:00:00Z", "2027-06-13T04:00:00Z"],
      ["2027-06-13T17:00:00Z", "2027-06-14T03:59:59Z"],
      ["2027-06-13T17:00:00Z", "2027-06-14T04:00:00Z"],
      ["2027-11-07T18:00:00Z", "2027-11-07T03:59:59Z"],
      ["2027-11-07T18:00:00Z", "2027-11-08T04:59:59Z"],
      ["2027-11-07T18:00:00Z", "2027-11-08T05:00:00Z"],
      ["2027-03-14T17:00:00Z", "2027-03-14T04:59:59Z"], // 23:59:59 EST Saturday before the spring change
      ["2027-03-14T17:00:00Z", "2027-03-14T05:00:00Z"], // 00:00 EST Sunday
      ["2027-03-14T17:00:00Z", "2027-03-15T03:59:59Z"], // 23:59:59 EDT Sunday
      ["2027-03-14T17:00:00Z", "2027-03-15T04:00:00Z"],
    ];
    for (const [race, moment] of instants) {
      expect(await onRaceDay(race, moment), `${race} @ ${moment}`).toBe(localDate(new Date(race)) === localDate(new Date(moment)));
    }
  });
});

describe("AC 1 — who, and when", () => {
  it("the crew confirms on the race day (23:59:59 tonight, not started): succeeds, status confirmed", async () => {
    const r = await as(db, "authenticated", set(RACES.todayLate.match, "confirmed"), CREW);
    expect(r.rows).toEqual([{ status: "accepted" }]); // the PRIOR status: a real transition happened
    expect(await statusOf(RACES.todayLate.match)).toBe("confirmed");
  });

  it("the crew is refused before 00:00 local on the race day (tomorrow's race), and the day after (yesterday's)", async () => {
    await expect(as(db, "authenticated", set(RACES.tomorrow.match, "confirmed"), CREW)).rejects.toThrow(/confirm on the race day/);
    await expect(as(db, "authenticated", set(RACES.yesterday.match, "confirmed"), CREW)).rejects.toThrow(/confirm on the race day/);
    expect(await statusOf(RACES.tomorrow.match)).toBe("accepted");
    expect(await statusOf(RACES.yesterday.match)).toBe("accepted");
  });

  it("the skipper may not confirm, even on the race day", async () => {
    await expect(as(db, "authenticated", set(RACES.todayEarly.match, "confirmed"), SKIPPER)).rejects.toThrow(/only the crew confirms/);
    expect(await statusOf(RACES.todayEarly.match)).toBe("accepted");
  });

  it("the crew may still confirm on the race day AFTER the start (00:00:01 today), which the skipper then marks sailed", async () => {
    await as(db, "authenticated", set(RACES.todayEarly.match, "confirmed"), CREW);
    expect(await statusOf(RACES.todayEarly.match)).toBe("confirmed");
    const r = await as(db, "authenticated", set(RACES.todayEarly.match, "sailed"), SKIPPER);
    expect(r.rows).toEqual([{ status: "confirmed" }]); // what it was, not what was asked
    expect(await statusOf(RACES.todayEarly.match)).toBe("sailed");
  });

  it("sailed and no_show are the skipper's only, and only after the start", async () => {
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "sailed"), SKIPPER)).rejects.toThrow(/after the start/);
    await expect(as(db, "authenticated", set(RACES.todayLate.match, "no_show"), SKIPPER)).rejects.toThrow(/after the start/);
    await expect(as(db, "authenticated", set(RACES.yesterday.match, "sailed"), CREW)).rejects.toThrow(/only the skipper/);
    await expect(as(db, "authenticated", set(RACES.yesterday.match, "no_show"), CREW)).rejects.toThrow(/only the skipper/);
    expect(await statusOf(RACES.todayLate.match)).toBe("confirmed");
    expect(await statusOf(RACES.yesterday.match)).toBe("accepted");
  });

  it("accepted → no_show by the skipper after the start", async () => {
    const r = await as(db, "authenticated", set(RACES.yesterday.match, "no_show"), SKIPPER);
    expect(r.rows).toEqual([{ status: "accepted" }]);
    expect(await statusOf(RACES.yesterday.match)).toBe("no_show");
  });

  it("accepted → sailed by the skipper after the start — a crew who forgot to confirm but turned up (owner decision 2026-09-18)", async () => {
    const r = await as(db, "authenticated", set(RACES.yesterday2.match, "sailed"), SKIPPER);
    expect(r.rows).toEqual([{ status: "accepted" }]);
    expect(await statusOf(RACES.yesterday2.match)).toBe("sailed");
  });
});

describe("AC 1 — the trigger: illegal transitions refused, terminal states final, a same-value write a no-op", () => {
  // Written as the table's OWNER, so the trigger is the only thing that can refuse: the definer's
  // who-and-when checks are the describe above's subject, and a refusal here that came from them
  // would prove the wrong claim.
  const move = (match: string, status: string) => db.query(`update public.match set status = '${status}' where id = '${match}'`);

  it("sailed is final: not confirmed, not accepted, not no_show", async () => {
    for (const to of ["confirmed", "accepted", "no_show"]) {
      await expect(move(RACES.todayEarly.match, to), to).rejects.toThrow(/match is sailed and that is final/);
    }
    expect(await statusOf(RACES.todayEarly.match)).toBe("sailed");
  });

  it("no_show is final too", async () => {
    for (const to of ["confirmed", "accepted", "sailed"]) {
      await expect(move(RACES.yesterday.match, to), to).rejects.toThrow(/match is no_show and that is final/);
    }
    expect(await statusOf(RACES.yesterday.match)).toBe("no_show");
  });

  it("confirmed may not go back to accepted", async () => {
    await expect(move(RACES.todayLate.match, "accepted")).rejects.toThrow(/may not go from confirmed to accepted/);
    expect(await statusOf(RACES.todayLate.match)).toBe("confirmed");
  });

  it("a same-value write is accepted as a no-op — a double tap is not an error", async () => {
    await move(RACES.todayLate.match, "confirmed");
    await move(RACES.yesterday2.match, "sailed");
    expect(await statusOf(RACES.todayLate.match)).toBe("confirmed");
    expect(await statusOf(RACES.yesterday2.match)).toBe("sailed");
    // and through the definer, as the person would: the crew taps Confirm twice on the race day.
    // The answer is the PRIOR status — 'confirmed' here against 'accepted' on the first tap —
    // which is the one signal the action has for "tell the skipper, or not" (fan-out finding:
    // without it a double tap in flight or a stale tab emailed the skipper twice).
    const r = await as(db, "authenticated", set(RACES.todayLate.match, "confirmed"), CREW);
    expect(r.rows).toEqual([{ status: "confirmed" }]);
  });

  it("positive control: the legal moves the file allows are exactly accepted→{confirmed,sailed,no_show} and confirmed→{sailed,no_show}", async () => {
    // A scratch match on the tomorrow post cannot be used (one match per post), so a fresh post
    // per probe on the same boat and date is not possible either; probe with a throwaway boat.
    await db.exec(`
      insert into public.boat (id, owner_id, name, class, default_minimum) values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', '${SKIPPER}', 'Probe', 'Thistle', 2);
      insert into public.post (id, boat_id, race_date_id, minimum, closed_at) values ('b0000000-0000-4000-8000-0000000000aa', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', '${RACES.tomorrow.date}', 2, now());
      insert into public.match (id, post_id, skipper_id, crew_id) values ('e0000000-0000-4000-8000-0000000000aa', 'b0000000-0000-4000-8000-0000000000aa', '${SKIPPER}', '${CREW}');
    `);
    const probe = "e0000000-0000-4000-8000-0000000000aa";
    const reset = () => db.query(`update public.match set status = 'accepted' where id = '${probe}'`);
    // The trigger refuses every backward move, so a reset needs it out of the way: disable, reset, enable.
    const resetHard = async () => {
      await db.exec(`alter table public.match disable trigger match_status_transition`);
      await reset();
      await db.exec(`alter table public.match enable trigger match_status_transition`);
    };
    const legal = [
      ["accepted", "confirmed"],
      ["accepted", "sailed"],
      ["accepted", "no_show"],
      ["confirmed", "sailed"],
      ["confirmed", "no_show"],
    ];
    for (const [from, to] of legal) {
      await resetHard();
      if (from !== "accepted") await move(probe, from);
      await move(probe, to);
      expect(await statusOf(probe), `${from} → ${to}`).toBe(to);
    }
    await resetHard();
  });
});
