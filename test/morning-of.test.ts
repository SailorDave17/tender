import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Message, Transport } from "@/email/send";
import { runMorningOf } from "@/engine/morningOf";
import { handleTick, type TickRunRow } from "@/engine/tick-handler";
import type { TickPost } from "@/engine/tick";
import { KIND_MORNING_OF, KIND_MORNING_OF_PUSH, remindCrew } from "@/notify/confirm";
import { dispatchPending } from "@/notify/rung";
import type { PushOutcome, PushTarget, PushTransport } from "@/push/send";
import { pgliteConfirmStore, pgliteMorningOfRepo } from "./morning-repo";
import { as, freshDb } from "./pglite";
import { pgliteDispatchStore, pgliteTickRepo } from "./tick-repo";

/**
 * The morning-of pass against real SQL — story #37 AC 2, driven through `handleTick()` exactly
 * as the route runs it, with the pglite adapters in place of the supabase-js ones. So a fixture
 * here exercises the real authorisation, the real ladder pass (which finds nothing: every post
 * below is matched, hence closed), the real reminder decision, the real send, and 0021's
 * `reminded_at` grant — the whole of the story's clock half except the Next binding and how
 * PostgREST spells a join.
 *
 * THE FIXTURE IS A TIMELINE, as test/tick.test.ts's is and for the same reason: the pass acts on
 * EVERY candidate, so the scenarios cannot share a race day. Each has its own Sunday, a week
 * apart in increasing order, and the tests run in that order — at any scenario's morning every
 * earlier race has sailed and every later one is a week out.
 *
 * THE OBSERVATION WINDOW OF EACH NEGATIVE CASE IS IN ITS NAME (AC 2's own words): a test that
 * says "sends nothing" names the instant it looked, because "nothing at 05:59" and "nothing
 * ever" are different claims.
 */

const SECRET = "cron-secret-for-the-tests";
const SITE = "https://tender.test";

const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Has a push subscription and an email. */
const CREW_PUSH = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Email only. */
const CREW_MAIL = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** No contact row at all. */
const CREW_NONE = "b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BOAT2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const BOAT3 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd3";
const ENDPOINT = "https://push.example/crew-push-device";

type Scenario = { date: string; post: string; match: string; race: Date; crew: string; boat?: string; status?: string };

/** Sundays at 1 pm EDT (17:00Z), a week apart, in the order the tests run. */
const S = {
  /** The ordinary case: a crew with push and email, reminded at 06:00. */
  due: {
    date: "c0000000-0000-4000-8000-000000000001",
    post: "b0000000-0000-4000-8000-000000000001",
    match: "e0000000-0000-4000-8000-000000000001",
    race: new Date("2027-06-13T17:00:00Z"),
    crew: CREW_PUSH,
  },
  /** A race the tick first sees after it started — the catch-up case. */
  started: {
    date: "c0000000-0000-4000-8000-000000000002",
    post: "b0000000-0000-4000-8000-000000000002",
    match: "e0000000-0000-4000-8000-000000000002",
    race: new Date("2027-06-20T17:00:00Z"),
    crew: CREW_MAIL,
  },
  /** Three matches already past 'accepted' and one still accepted, all on one morning. */
  confirmed: {
    date: "c0000000-0000-4000-8000-000000000003",
    post: "b0000000-0000-4000-8000-000000000003",
    match: "e0000000-0000-4000-8000-000000000003",
    race: new Date("2027-06-27T17:00:00Z"),
    crew: CREW_MAIL,
    status: "confirmed",
  },
  sailed: {
    date: "c0000000-0000-4000-8000-000000000003",
    post: "b0000000-0000-4000-8000-000000000004",
    match: "e0000000-0000-4000-8000-000000000004",
    race: new Date("2027-06-27T17:00:00Z"),
    crew: CREW_PUSH,
    boat: BOAT2,
    status: "sailed",
  },
  noShow: {
    date: "c0000000-0000-4000-8000-000000000003",
    post: "b0000000-0000-4000-8000-000000000005",
    match: "e0000000-0000-4000-8000-000000000005",
    race: new Date("2027-06-27T17:00:00Z"),
    crew: CREW_NONE,
    boat: BOAT3,
    status: "no_show",
  },
  /** The positive control beside the three above: a crew with no contact row, still accepted. */
  noAddress: {
    date: "c0000000-0000-4000-8000-000000000006",
    post: "b0000000-0000-4000-8000-000000000006",
    match: "e0000000-0000-4000-8000-000000000006",
    race: new Date("2027-07-04T17:00:00Z"),
    crew: CREW_NONE,
  },
} satisfies Record<string, Scenario>;

const emailOf = (id: string) => `${id}@example.org`;

class FakeTransport implements Transport {
  sent: Message[] = [];
  async send(message: Message) {
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
}

class FakePush implements PushTransport {
  sent: { endpoint: string; tag: string }[] = [];
  async send(target: PushTarget, payload: { tag: string }): Promise<PushOutcome> {
    this.sent.push({ endpoint: target.endpoint, tag: payload.tag });
    return { ok: true };
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

/** One tick, exactly as the route runs one: ladder pass, dispatch, morning-of pass, stamp. */
async function tick(now: Date) {
  const transport = new FakeTransport();
  const push = new FakePush();
  const store = pgliteConfirmStore(db);
  const dispatchStore = pgliteDispatchStore(db);
  const reminded: string[] = [];
  const response = await handleTick({
    authorization: `Bearer ${SECRET}`,
    cronSchedule: null,
    secret: SECRET,
    repo: pgliteTickRepo(db),
    dispatch: async (post: TickPost) => {
      await dispatchPending(post, { store: dispatchStore, transport, now, siteUrl: SITE });
    },
    recordRun: async (row: TickRunRow) => {
      await svc(`insert into public.tick_run (id, last_at) values ($1, $2) on conflict (id) do update set last_at = excluded.last_at`, [
        row.id,
        row.last_at,
      ]);
    },
    // The real pass over the real adapter, per match through the real sender — what the route's
    // `morningOfLive` composes, minus the swallow.
    morningOf: async (at: Date) => {
      const result = await runMorningOf(
        pgliteMorningOfRepo(db),
        async (m) => {
          await remindCrew(m, { store, transport, push, now: at, siteUrl: SITE });
        },
        at,
      );
      reminded.push(...result.due);
    },
    now,
  });
  return { response, emailed: transport.sent.map((m) => m.to).sort(), sent: transport.sent, pushed: push.sent, reminded };
}

async function remindedAt(matchId: string): Promise<string | null> {
  const r = await db.query<{ reminded_at: string | null }>(`select reminded_at::text from public.match where id = $1`, [matchId]);
  return r.rows[0].reminded_at;
}

async function logKinds(postId: string): Promise<string[]> {
  const r = await db.query<{ kind: string }>(`select kind from public.notification_log where post_id = $1 order by sent_at, kind`, [postId]);
  return r.rows.map((x) => x.kind);
}

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${SKIPPER}'), ('${CREW_PUSH}'), ('${CREW_MAIL}'), ('${CREW_NONE}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${SKIPPER}', 'Sam Skipper', now(), 4),
      ('${CREW_PUSH}', 'Pat Push', now(), 3),
      ('${CREW_MAIL}', 'Mo Mail', now(), 3),
      ('${CREW_NONE}', 'Nic None', now(), 3);
    insert into public.person_contact (person_id, email) values
      ('${SKIPPER}', '${emailOf(SKIPPER)}'), ('${CREW_PUSH}', '${emailOf(CREW_PUSH)}'), ('${CREW_MAIL}', '${emailOf(CREW_MAIL)}');
    insert into public.push_subscription (person_id, endpoint, p256dh, auth)
      values ('${CREW_PUSH}', '${ENDPOINT}', 'k', 'a');
    insert into public.boat (id, owner_id, name, class, default_minimum) values
      ('${BOAT}', '${SKIPPER}', 'Blue Moon', 'Thistle', 2),
      ('${BOAT2}', '${SKIPPER}', 'Kestrel', 'Thistle', 2),
      ('${BOAT3}', '${SKIPPER}', 'Osprey', 'Thistle', 2);
  `);
  const dates = new Set<string>();
  for (const [name, s] of Object.entries(S) as [string, Scenario][]) {
    if (!dates.has(s.date)) {
      dates.add(s.date);
      await db.query(`insert into public.race_date (id, starts_at, title, published) values ($1, $2, $3, true)`, [
        s.date,
        s.race.toISOString(),
        `Series — ${name}`,
      ]);
    }
    // A matched post is a closed post (accept_answer() closes it); written as the owner here,
    // since the writing route is 0008's own test's subject and this file's is the morning after.
    await db.query(`insert into public.post (id, boat_id, race_date_id, minimum, closed_at) values ($1, $2, $3, 2, now())`, [
      s.post,
      s.boat ?? BOAT,
      s.date,
    ]);
    await db.query(`insert into public.match (id, post_id, skipper_id, crew_id, status) values ($1, $2, $3, $4, $5)`, [
      s.match,
      s.post,
      SKIPPER,
      s.crew,
      s.status ?? "accepted",
    ]);
  }
});

afterAll(async () => {
  await db.close();
});

describe("0021 — who may write what (the grants the pass rests on)", () => {
  it("service_role may set reminded_at and may NOT set status; no client role may set either", async () => {
    // The positive control first: the column the pass writes.
    const mark = await as(db, "service_role", `update public.match set reminded_at = now() where id = '${S.noAddress.match}' returning id`);
    expect(mark.rows).toHaveLength(1);
    await as(db, "service_role", `update public.match set reminded_at = null where id = '${S.noAddress.match}'`);
    expect(await remindedAt(S.noAddress.match)).toBeNull();
    // status is the definer's alone — a bug in the tick cannot mark anyone sailed.
    await expect(as(db, "service_role", `update public.match set status = 'sailed' where id = '${S.noAddress.match}'`)).rejects.toThrow(
      /permission denied for table match/,
    );
    await expect(
      as(db, "authenticated", `update public.match set reminded_at = now() where id = '${S.due.match}'`, S.due.crew),
    ).rejects.toThrow(/permission denied for table match/);
    await expect(
      as(db, "authenticated", `update public.match set status = 'confirmed' where id = '${S.due.match}'`, S.due.crew),
    ).rejects.toThrow(/permission denied for table match/);
  });

  it("reminded_at is not in any client role's select list", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee in ('anon', 'authenticated') and table_schema = 'public' and table_name = 'match' and column_name = 'reminded_at'`,
    );
    expect(cols.rows).toEqual([]);
  });
});

describe("AC 2 — on the race morning at 06:00 the accepted crew is asked, once", () => {
  it("sends nothing at 05:59:59 EDT on the race day, and reminded_at stays null", async () => {
    const { emailed, pushed, reminded } = await tick(new Date("2027-06-13T09:59:59Z"));
    expect(emailed).toEqual([]);
    expect(pushed).toEqual([]);
    expect(reminded).toEqual([]);
    expect(await remindedAt(S.due.match)).toBeNull();
  });

  it("sends nothing at 23:59 EDT the night before either — the day is the club's calendar day", async () => {
    const { emailed, reminded } = await tick(new Date("2027-06-13T03:59:00Z"));
    expect(emailed).toEqual([]);
    expect(reminded).toEqual([]);
  });

  it("at 06:00:00 EDT: a push to the crew's device, an email with the Confirm link, reminded_at set to the tick's clock", async () => {
    const now = new Date("2027-06-13T10:00:00Z");
    const { response, emailed, sent, pushed, reminded } = await tick(now);
    expect(response.status).toBe(200);
    expect(reminded).toEqual([S.due.match]);
    expect(emailed).toEqual([emailOf(CREW_PUSH)]);
    expect(sent[0].subject).toContain("Confirm for today");
    expect(sent[0].text).toContain(`${SITE}/post/${S.due.post}`);
    expect(pushed).toEqual([{ endpoint: ENDPOINT, tag: `post-${S.due.post}-confirm` }]);
    expect(await remindedAt(S.due.match)).not.toBeNull();
    expect(new Date((await remindedAt(S.due.match))!).toISOString()).toBe(now.toISOString());
    expect((await logKinds(S.due.post)).sort()).toEqual([KIND_MORNING_OF, KIND_MORNING_OF_PUSH].sort());
  });

  it("a second tick fifteen minutes later sends nothing and reminds nobody", async () => {
    const { emailed, pushed, reminded } = await tick(new Date("2027-06-13T10:15:00Z"));
    expect(emailed).toEqual([]);
    expect(pushed).toEqual([]);
    expect(reminded).toEqual([]);
    expect(await logKinds(S.due.post)).toHaveLength(2); // the two rows from the first pass, no more
  });
});

describe("AC 2 — a tick that first runs after the start sends nothing (owner decision 2026-09-18)", () => {
  it("at 14:00 EDT on the race day, with the race started at 13:00, the accepted match is left alone", async () => {
    expect(await remindedAt(S.started.match)).toBeNull(); // the precondition
    const { emailed, reminded } = await tick(new Date("2027-06-20T18:00:00Z"));
    expect(emailed).toEqual([]);
    expect(reminded).toEqual([]);
    expect(await remindedAt(S.started.match)).toBeNull(); // not marked either: nothing was attempted
  });
});

describe("AC 2 — a match already confirmed, sailed or no_show sends nothing", () => {
  it("at 08:00 EDT on their race day none of the three is reminded, while an accepted match the same morning would be", async () => {
    // The three non-accepted matches all sit on the 2027-06-27 race; the assertion is that the
    // pass at 08:00 that morning reads them as candidates NOT AT ALL (the adapter filters on
    // status) and so hands nobody to the sender. Positive control: the very same pass's
    // predicate says an accepted match on that morning IS due — proven by the noAddress scenario
    // a week later, and here by the repo's own candidate list.
    const candidates = await pgliteMorningOfRepo(db).candidates();
    const ids = candidates.map((c) => c.id);
    expect(ids).not.toContain(S.confirmed.match);
    expect(ids).not.toContain(S.sailed.match);
    expect(ids).not.toContain(S.noShow.match);
    expect(ids).toContain(S.noAddress.match); // still accepted, still unreminded: a candidate

    const { emailed, pushed, reminded } = await tick(new Date("2027-06-27T12:00:00Z"));
    expect(emailed).toEqual([]);
    expect(pushed).toEqual([]);
    expect(reminded).toEqual([]);
    for (const m of [S.confirmed.match, S.sailed.match, S.noShow.match]) expect(await remindedAt(m)).toBeNull();
  });
});

describe("a crew with no contact row is marked reminded with the failure logged, not retried every quarter-hour", () => {
  it("at 06:30 EDT: no email, no push, a morning_of row carrying the error, reminded_at set", async () => {
    const { emailed, pushed, reminded } = await tick(new Date("2027-07-04T10:30:00Z"));
    expect(reminded).toEqual([S.noAddress.match]);
    expect(emailed).toEqual([]);
    expect(pushed).toEqual([]);
    const log = await db.query<{ kind: string; error: string | null }>(
      `select kind, error from public.notification_log where post_id = $1`,
      [S.noAddress.post],
    );
    expect(log.rows).toEqual([{ kind: KIND_MORNING_OF, error: "no contact email" }]);
    expect(await remindedAt(S.noAddress.match)).not.toBeNull();
    const again = await tick(new Date("2027-07-04T10:45:00Z"));
    expect(again.reminded).toEqual([]);
  });
});
