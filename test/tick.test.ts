import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Message, Transport } from "@/email/send";
import { handleTick } from "@/engine/tick-handler";
import type { TickPost } from "@/engine/tick";
import { dispatchPending } from "@/notify/rung";
import { as, freshDb } from "./pglite";
import { pgliteDispatchStore, pgliteTickRepo } from "./tick-repo";

/**
 * The ladder tick against real SQL — story #25 AC 2, AC 3, AC 4 and the tick_run half of AC 5.
 *
 * Everything below is driven through `handleTick()`, the same function the route calls, with the
 * pglite adapters in place of the supabase-js ones. So a fixture here exercises the real
 * authorisation, the real ladder, the real dispatch, 0010's primary key and monotone trigger, and
 * 0012's grants — the whole of the story except the Next binding and how PostgREST spells a join.
 * A test that composed those pieces itself would prove they can be composed, not that the thing
 * the route calls composes them (cairn: prove-a-guard-test-can-fail, twelfth outcome).
 *
 * THE FIXTURE IS A TIMELINE, and that is not cosmetic. A tick acts on EVERY open post, so the
 * scenarios cannot share a race instant: the first draft gave them all one, and a single tick at
 * "47 h before the race" was 47 h before six races at once and emailed the rung-2 crew six times.
 * Each scenario therefore has its own race, they are a week apart in increasing order, and the
 * tests run in that order — so at any scenario's moment every earlier race has already sailed
 * (and is excluded by `openPosts`) and every later one is weeks out with nothing new to say.
 * `posts` in a response body is consequently a number that changes down the file, which is why
 * the assertions on it are about `newSuggestions`.
 */

const SECRET = "cron-secret-for-the-tests";
const SITE = "https://tender.test";
const HOUR = 60 * 60 * 1000;

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// For a Thistle post at minimum 2: r1 is rung 1, r2 rung 2 (wrong hull), r3 rung 3 (under it).
const R1 = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const R2 = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const R3 = "b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** A second rung-2 crew, used only by the "the stored rung never narrows" scenario. */
const R2B = "b4b4b4b4-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Scenario = {
  date: string;
  post: string;
  race: Date;
  available: string[];
  /** The post's stored rung at the start. Default 1, as 0006 creates it. */
  rung?: 1 | 2 | 3;
  /** The crew already suggested and told, as story #23's post-create pass leaves them. Default R1. */
  told?: string;
};

/** In race order, which is also the order the tests below run in. */
const S = {
  clock: {
    date: "c0000000-0000-4000-8000-000000000001",
    post: "b0000000-0000-4000-8000-000000000001",
    race: new Date("2027-06-13T17:00:00Z"),
    available: [R1, R2, R3],
  },
  // No rung-3 crew: when rung 1 empties, the widening must stop at 2 with somebody on it.
  empty: {
    date: "c0000000-0000-4000-8000-000000000002",
    post: "b0000000-0000-4000-8000-000000000002",
    race: new Date("2027-06-20T17:00:00Z"),
    available: [R1, R2],
  },
  // Already widened to rung 2 and told R2, with nobody on rung 1 — the state a post is in when
  // a better crew turns up later. Starts with R2 alone available; the test adds the others.
  regress: {
    date: "c0000000-0000-4000-8000-000000000007",
    post: "b0000000-0000-4000-8000-000000000007",
    race: new Date("2027-06-24T17:00:00Z"),
    available: [R2],
    rung: 2,
    told: R2,
  },
  catchUp: {
    date: "c0000000-0000-4000-8000-000000000003",
    post: "b0000000-0000-4000-8000-000000000003",
    race: new Date("2027-06-27T17:00:00Z"),
    available: [R1, R2, R3],
  },
  matched: {
    date: "c0000000-0000-4000-8000-000000000004",
    post: "b0000000-0000-4000-8000-000000000004",
    race: new Date("2027-07-04T17:00:00Z"),
    available: [R1, R2, R3],
  },
  closed: {
    date: "c0000000-0000-4000-8000-000000000005",
    post: "b0000000-0000-4000-8000-000000000005",
    race: new Date("2027-07-04T17:00:00Z"),
    available: [R1, R2, R3],
  },
  // Never ticked near; it exists for the on-conflict case alone.
  conflict: {
    date: "c0000000-0000-4000-8000-000000000006",
    post: "b0000000-0000-4000-8000-000000000006",
    race: new Date("2027-08-01T17:00:00Z"),
    available: [R1, R2, R3],
  },
} satisfies Record<string, Scenario>;

const before = (s: Scenario, hours: number) => new Date(s.race.getTime() - hours * HOUR);
const emailOf = (id: string) => `${id}@example.org`;

class FakeTransport implements Transport {
  sent: Message[] = [];
  refuse = new Set<string>();
  async send(message: Message) {
    if (this.refuse.has(message.to)) throw new Error("provider said no");
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
}

let db: PGlite;

async function svc(sql: string, params: unknown[] = []) {
  await db.exec(`set role service_role;`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role;`);
  }
}

/** One tick, exactly as the route runs one — the same handler, the same order, real SQL beneath. */
async function tick(now: Date, opts: { authorization?: string | null; refuse?: string[] } = {}) {
  const transport = new FakeTransport();
  for (const to of opts.refuse ?? []) transport.refuse.add(to);
  const store = pgliteDispatchStore(db);
  const response = await handleTick({
    authorization: opts.authorization === undefined ? `Bearer ${SECRET}` : opts.authorization,
    secret: SECRET,
    repo: pgliteTickRepo(db),
    dispatch: async (post: TickPost) => {
      await dispatchPending(post, { store, transport, now, siteUrl: SITE });
    },
    // What src/engine/tick-store.ts's recordTickRun() does, in this adapter's dialect: the
    // upsert runs as the service role, so 0012's grants decide whether it lands.
    recordRun: async (at: Date) => {
      await svc(
        `insert into public.tick_run (id, last_at) values (1, $1)
           on conflict (id) do update set last_at = excluded.last_at`,
        [at.toISOString()],
      );
    },
    now,
  });
  return { response, emailed: transport.sent.map((m) => m.to).sort(), sent: transport.sent };
}

async function rungOf(postId: string): Promise<number> {
  const r = await db.query<{ current_rung: number }>(`select current_rung from public.post where id = $1`, [postId]);
  return r.rows[0].current_rung;
}

async function suggestionCount(postId: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from public.suggestion where post_id = $1`, [postId]);
  return r.rows[0].n;
}

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${R1}'), ('${R2}'), ('${R2B}'), ('${R3}');
    insert into public.person (id, display_name, adult_attested_at, rating, any_hull, hulls) values
      ('${SKIPPER}', 'Sam Skipper', now(), 4, true,  '{}'),
      ('${R1}',      'Ana Rung1',   now(), 3, false, '{Thistle}'),
      ('${R2}',      'Bo Rung2',    now(), 2, false, '{"Flying Scot"}'),
      ('${R2B}',     'Di Rung2',    now(), 2, false, '{Interlake}'),
      ('${R3}',      'Cy Rung3',    now(), 1, false, '{Thistle}');
    insert into public.person_contact (person_id, email) values
      ('${SKIPPER}', '${emailOf(SKIPPER)}'),
      ('${R1}', '${emailOf(R1)}'), ('${R2}', '${emailOf(R2)}'),
      ('${R2B}', '${emailOf(R2B)}'), ('${R3}', '${emailOf(R3)}');
    insert into public.boat (id, owner_id, name, class, default_minimum)
      values ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2);
  `);

  for (const [name, s] of Object.entries(S) as [string, Scenario][]) {
    await db.query(`insert into public.race_date (id, starts_at, title, published) values ($1, $2, $3, true)`, [
      s.date,
      s.race.toISOString(),
      `Series — ${name}`,
    ]);
    await db.query(
      `insert into public.post (id, boat_id, race_date_id, minimum, current_rung) values ($1, $2, $3, 2, $4)`,
      [s.post, BOAT, s.date, s.rung ?? 1],
    );
    for (const p of s.available) {
      await db.query(`insert into public.availability (person_id, race_date_id) values ($1, $2)`, [p, s.date]);
    }
    // Every scenario starts where story #23 leaves a post: open at some rung, with the crew on
    // that rung already suggested and told.
    await db.query(`insert into public.suggestion (post_id, person_id, rung, notified_at) values ($1, $2, $3, now())`, [
      s.post,
      s.told ?? R1,
      s.rung ?? 1,
    ]);
  }
});

afterAll(async () => {
  await db.close();
});

/**
 * AC 2. The clock reaches rung 2 at 48 h; a tick at 47 h widens the post and tells exactly the
 * crew the widening reached — not the rung-1 crew again, and not rung 3.
 */
describe("AC 2 — 47 h before the race, the post widens to rung 2 and only rung 2 is emailed", () => {
  it("widens the post, emails exactly the rung-2 crew, and reports one new suggestion", async () => {
    expect(await rungOf(S.clock.post)).toBe(1); // the precondition, or the assertions below prove nothing
    const { response, emailed } = await tick(before(S.clock, 47));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ posts: expect.any(Number), newSuggestions: 1 });
    expect(await rungOf(S.clock.post)).toBe(2);
    expect(emailed).toEqual([emailOf(R2)]);
  });

  it("records the send, so the day's count against Resend's cap is right", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.notification_log
        where post_id = $1 and kind = 'rung_email' and error is null`,
      [S.clock.post],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("run again a minute later: nothing new is suggested, nobody is emailed, the rung stands", async () => {
    const rows = await suggestionCount(S.clock.post);
    const { response, emailed } = await tick(new Date(before(S.clock, 47).getTime() + 60_000));
    expect(response.body).toEqual({ posts: expect.any(Number), newSuggestions: 0 });
    expect(emailed).toEqual([]);
    expect(await suggestionCount(S.clock.post)).toBe(rows);
    expect(await rungOf(S.clock.post)).toBe(2);
  });
});

/**
 * AC 2's third clause, and nothing to do with the clock: at 72 h the post is open at rung 1 with
 * a rung-1 crew on it. When that crew withdraws, the rung is empty and the post must widen on the
 * next tick — the emptiness half of suggest(), now persisted rather than recomputed on read.
 */
describe("AC 2 — a rung-1 crew withdrawing empties the rung, and the next tick widens the post", () => {
  it("does nothing while the rung-1 crew is still available", async () => {
    const { emailed } = await tick(before(S.empty, 72));
    expect(emailed).toEqual([]);
    expect(await rungOf(S.empty.post)).toBe(1);
  });

  it("widens to rung 2 and emails the rung-2 crew once the rung-1 crew withdraws", async () => {
    await db.query(`delete from public.availability where person_id = $1 and race_date_id = $2`, [R1, S.empty.date]);
    const { emailed } = await tick(before(S.empty, 72));
    expect(await rungOf(S.empty.post)).toBe(2);
    expect(emailed).toEqual([emailOf(R2)]);
  });
});

/**
 * The other direction, and the one no clock scenario reaches: the engine's answer gets NARROWER
 * than the stored rung. A post widened to rung 2 and told its rung-2 crew; a rung-1 crew then
 * marks the day, so suggest() answers 1 again — and if the tick took that answer it would stop
 * proposing rung 2 at all, silently, on a post whose rung-2 crew have already been told "we need
 * you". `openRung()`'s max is the only thing that stops it.
 *
 * This scenario exists because writing the mutation predictions down first showed the monotone
 * max had exactly one test able to catch it, and that test was a call-recording unit test rather
 * than anything touching a database (cairn: prove-a-guard-test-can-fail — the count is the point).
 */
describe("the stored rung never narrows, so a crew on an opened rung is still reached", () => {
  it("widens nothing, keeps rung 2, and reaches BOTH the new rung-1 crew and an untold rung-2 crew", async () => {
    expect(await rungOf(S.regress.post)).toBe(2); // the precondition
    await db.query(`insert into public.availability (person_id, race_date_id) values ($1, $2), ($3, $2)`, [
      R1,
      S.regress.date,
      R2B,
    ]);

    const { emailed } = await tick(before(S.regress, 72));
    expect(await rungOf(S.regress.post)).toBe(2); // suggest() says 1 here; the stored rung wins
    expect(emailed).toEqual([emailOf(R1), emailOf(R2B)].sort());
  });
});

/**
 * AC 3. Supabase Free pauses a project after 7 idle days and pg_cron stops with it, so the tick
 * that should have run at 48 h is exactly the one that will not have. Catching up must therefore
 * be safe LATE and in ONE pass: at 20 h the clock is already at rung 3, and both missed rungs are
 * told in the same call.
 */
describe("AC 3 — a tick that first runs at 20 h reaches rung 2 and rung 3 in one pass", () => {
  it("sets current_rung to 3 and emails rung 2 and rung 3 exactly once each", async () => {
    expect(await rungOf(S.catchUp.post)).toBe(1);
    const { response, emailed } = await tick(before(S.catchUp, 20));
    expect(response.body).toEqual({ posts: expect.any(Number), newSuggestions: 2 });
    expect(await rungOf(S.catchUp.post)).toBe(3);
    expect(emailed).toEqual([emailOf(R2), emailOf(R3)].sort());
  });

  it("and a second pass an hour later sends nothing further", async () => {
    const { emailed } = await tick(before(S.catchUp, 19));
    expect(emailed).toEqual([]);
    expect(await rungOf(S.catchUp.post)).toBe(3);
  });
});

/**
 * AC 4. A matched post is a closed post — accept_answer() (0008) writes the match and sets
 * closed_at in one transaction — which is why openPosts() carries ONE clause and not two. The
 * first case here is the invariant that single clause rests on: the day accepting an answer stops
 * closing the post, this goes red rather than production going quiet.
 */
describe("AC 4 — a matched or closed post crossing 48 h sends nothing", () => {
  it("accepting an answer closes the post — the invariant openPosts() rests on", async () => {
    await db.query(`insert into public.answer (post_id, person_id) values ($1, $2)`, [S.matched.post, R1]);
    await as(db, "authenticated", `select public.accept_answer('${S.matched.post}', '${R1}')`, SKIPPER);
    const r = await db.query<{ closed_at: string | null }>(`select closed_at from public.post where id = $1`, [
      S.matched.post,
    ]);
    expect(r.rows[0].closed_at).not.toBeNull();
  });

  it("neither the matched post nor one the skipper closed by hand is touched at 47 h", async () => {
    await db.query(`update public.post set closed_at = now() where id = $1`, [S.closed.post]);
    const state = async () => ({
      matchedRows: await suggestionCount(S.matched.post),
      closedRows: await suggestionCount(S.closed.post),
      matchedRung: await rungOf(S.matched.post),
      closedRung: await rungOf(S.closed.post),
    });
    const was = await state();

    const { response, emailed } = await tick(before(S.matched, 47));

    expect(emailed).toEqual([]);
    expect(response.body).toEqual({ posts: expect.any(Number), newSuggestions: 0 });
    expect(await state()).toEqual(was);
  });
});

/**
 * The primary key on (post_id, person_id) is what makes a tick safe to run again, and it is the
 * only thing standing between a scheduler firing every 15 minutes and a crew emailed 96 times a
 * day. runTick() hands the insert EVERY candidate rather than filtering to the new ones, so this
 * clause is load-bearing rather than a spare.
 */
describe("re-offering a suggestion is a no-op — the row, its rung and its notified_at all stand", () => {
  it("leaves an existing pair untouched and queues only the genuinely new one", async () => {
    const repo = pgliteTickRepo(db);
    const was = await db.query<{ rung: number; notified_at: string | null }>(
      `select rung, notified_at::text from public.suggestion where post_id = $1 and person_id = $2`,
      [S.conflict.post, R1],
    );
    expect(was.rows[0].notified_at).not.toBeNull(); // the precondition

    await repo.insertSuggestions([
      { postId: S.conflict.post, personId: R1, rung: 3 }, // a different rung, deliberately
      { postId: S.conflict.post, personId: R2, rung: 2 },
    ]);

    const after = await db.query<{ person_id: string; rung: number; notified_at: string | null }>(
      `select person_id, rung, notified_at::text from public.suggestion where post_id = $1 order by person_id`,
      [S.conflict.post],
    );
    expect(after.rows).toHaveLength(2);
    const kept = after.rows.find((r) => r.person_id === R1)!;
    expect(kept.rung).toBe(was.rows[0].rung); // untouched, not overwritten with 3
    expect(kept.notified_at).toBe(was.rows[0].notified_at);
    expect(after.rows.find((r) => r.person_id === R2)!.notified_at).toBeNull();
  });
});

/**
 * A send the provider refuses leaves notified_at NULL, so the person stays queued — but the CLOCK
 * does not retry them, because a post whose rung did not move reaches nobody new and is not
 * dispatched. That is a deliberate choice (src/engine/tick-handler.ts): retrying on every tick
 * would spend the day's cap on an address that will refuse it ninety-six times.
 */
describe("a refused send stays queued, and the clock does not spend the cap retrying it", () => {
  const DATE = "c0000000-0000-4000-8000-0000000000ff";
  const POST = "b0000000-0000-4000-8000-0000000000ff";
  const RACE = new Date("2027-08-15T17:00:00Z");

  it("leaves the person pending after a refusal, and the next tick does not try again", async () => {
    await db.query(`insert into public.race_date (id, starts_at, title, published) values ($1, $2, 'Refusal', true)`, [
      DATE,
      RACE.toISOString(),
    ]);
    await db.query(
      `insert into public.post (id, boat_id, race_date_id, minimum, current_rung) values ($1, $2, $3, 2, 3)`,
      [POST, BOAT, DATE],
    );
    await db.query(`insert into public.availability (person_id, race_date_id) values ($1, $2)`, [R2, DATE]);

    const first = await tick(new Date(RACE.getTime() - 20 * HOUR), { refuse: [emailOf(R2)] });
    expect(first.emailed).toEqual([]); // the only candidate, refused by the provider
    expect(first.response.body).toEqual({ posts: 1, newSuggestions: 1 });
    const pending = await db.query<{ n: number }>(
      `select count(*)::int as n from public.suggestion where post_id = $1 and notified_at is null`,
      [POST],
    );
    expect(pending.rows[0].n).toBe(1); // still queued for the next post or availability toggle

    const second = await tick(new Date(RACE.getTime() - 19 * HOUR));
    expect(second.emailed).toEqual([]);
    expect(second.response.body).toEqual({ posts: 1, newSuggestions: 0 });
  });
});

/**
 * AC 5's other half: the stamp. It is what separates a clock that ran and found nothing from a
 * clock that is dead, and 0012 lets only the service role write it and only an admin read it.
 */
describe("AC 5 — tick_run records the run, and only an admin can read it", () => {
  const QUIET = new Date("2027-09-01T00:00:00Z"); // after every race above: nothing open to act on

  it("a tick with nothing to do still stamps — one row, by construction", async () => {
    const { response } = await tick(QUIET);
    expect(response.body).toEqual({ posts: 0, newSuggestions: 0 });
    const r = await db.query<{ n: number; last_at: string }>(
      `select count(*)::int as n, max(last_at)::text as last_at from public.tick_run`,
    );
    expect(r.rows[0].n).toBe(1);
    expect(new Date(r.rows[0].last_at).getTime()).toBe(QUIET.getTime());
  });

  it("an unauthorised call leaves the stamp where it was", async () => {
    const was = await db.query<{ last_at: string }>(`select last_at::text from public.tick_run`);
    const { response } = await tick(new Date("2027-09-02T00:00:00Z"), { authorization: null });
    expect(response.status).toBe(401);
    expect((await db.query<{ last_at: string }>(`select last_at::text from public.tick_run`)).rows).toEqual(was.rows);
  });

  it("an admin reads it; a signed-in crew reads nothing; anon is refused outright", async () => {
    await db.exec(`update public.person set is_admin = true where id = '${SKIPPER}';`);
    expect((await as(db, "authenticated", `select last_at from public.tick_run`, SKIPPER)).rows).toHaveLength(1);
    // Zero rows, not an error — 0012's header records why that ambiguity is a trap worth naming.
    expect((await as(db, "authenticated", `select last_at from public.tick_run`, R1)).rows).toEqual([]);
    await expect(as(db, "anon", `select last_at from public.tick_run`)).rejects.toThrow(/permission denied/);
  });

  it("no client role may write it — the server's record of its own clock is not a client's to fake", async () => {
    await expect(
      as(db, "authenticated", `update public.tick_run set last_at = now() - interval '1 year'`, SKIPPER),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, "authenticated", `insert into public.tick_run (id, last_at) values (1, now())`, SKIPPER),
    ).rejects.toThrow(/permission denied/);
  });
});
