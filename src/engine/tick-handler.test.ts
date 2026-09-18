import { describe, expect, it } from "vitest";
import type { Crew, Rung } from "./ladder";
import { handleTick, tickCaller, VERCEL_CRON_HEADER, type TickRunRow } from "./tick-handler";
import type { NewSuggestion, Suggested, TickPost, TickRepo } from "./tick";

/**
 * What /api/ladder/tick answers and, more to the point, what it touches (story #25 AC 5).
 *
 * AC 5's real claim is not "401" — it is "401 AND THE REPO IS UNTOUCHED", which no assertion on a
 * response body can reach. That is why the repo here records every call it receives: the test
 * asserts an empty call list, so a route that ran the tick and then threw away the result would
 * fail even though its status code was right.
 */

const SECRET = "cron-secret-for-the-tests";
const NOW = new Date("2027-06-06T12:00:00Z");
const RACE = new Date("2027-06-13T17:00:00Z");
/** What Vercel sends as `x-vercel-cron-schedule` for `vercel.json`'s one cron. */
const DAILY = "0 12 * * *";

const post = (id: string): TickPost => ({
  id,
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: RACE.toISOString(),
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: null,
});

class RecordingRepo implements TickRepo {
  calls: string[] = [];
  posts: TickPost[] = [];
  pool: Crew[] = [];
  existing = new Map<string, Suggested[]>();
  /**
   * How many rows on each post are owed a send AFTER this pass's insert (#128). Set per test, and
   * deliberately independent of `existing` — a row can be in `existing` and still pending (the cap
   * skipped it) or in `existing` and settled (it was emailed), which is the whole distinction the
   * story turns on and which a value derived from `existing` could not express.
   *
   * The default is the honest one for a repo that has just been handed new candidates: whatever a
   * test does not override, `setUp` computes from the pass itself.
   */
  pending = new Map<string, number>();

  async openPosts(): Promise<TickPost[]> {
    this.calls.push("openPosts");
    return this.posts;
  }
  async poolFor(): Promise<Crew[]> {
    this.calls.push("poolFor");
    return this.pool;
  }
  async suggestionsFor(postId: string): Promise<Suggested[]> {
    this.calls.push("suggestionsFor");
    return this.existing.get(postId) ?? [];
  }
  async pendingCount(postId: string): Promise<number> {
    this.calls.push(`pendingCount(${postId})`);
    return this.pending.get(postId) ?? 0;
  }
  async setRung(postId: string, rung: Rung) {
    this.calls.push(`setRung(${postId},${rung})`);
  }
  async insertSuggestions(rows: NewSuggestion[]) {
    this.calls.push(`insertSuggestions(${rows.length})`);
  }
}

function setUp(over: { pool?: Crew[]; posts?: TickPost[]; pending?: Record<string, number> } = {}) {
  const repo = new RecordingRepo();
  repo.posts = over.posts ?? [post("p1")];
  repo.pool = over.pool ?? [{ id: "a", rating: 2, hulls: ["Thistle"], available: true }];
  // Default: every post is owed one send — the ordinary state after a pass that proposed somebody.
  // A test measuring the pending condition itself overrides it, which is the point of the field.
  for (const p of repo.posts) repo.pending.set(p.id, over.pending?.[p.id] ?? 1);
  const dispatched: string[] = [];
  const stamps: TickRunRow[] = [];
  const deps = {
    secret: SECRET,
    // pg_cron's POST, unless a test says otherwise: it carries no x-vercel-cron-schedule.
    cronSchedule: null as string | null,
    repo,
    dispatch: async (p: TickPost) => {
      dispatched.push(p.id);
    },
    recordRun: async (row: TickRunRow) => {
      stamps.push(row);
    },
    now: NOW,
  };
  return { repo, dispatched, stamps, deps };
}

/** The row pg_cron's tick writes: `last_at` and nothing else, so the daily stamp is left alone. */
const clockRow = { id: 1, last_at: NOW.toISOString() };

describe("handleTick — the refusal", () => {
  for (const [name, header] of [
    ["no header at all", null],
    ["the wrong secret", `Bearer not-the-secret`],
    ["the secret with no scheme", SECRET],
    ["an empty bearer", "Bearer "],
  ] as const) {
    it(`401s on ${name}, and the repo is untouched`, async () => {
      const { repo, dispatched, stamps, deps } = setUp();
      const res = await handleTick({ ...deps, authorization: header });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "unauthorized" });
      expect(repo.calls).toEqual([]); // nothing was read, nothing was written
      expect(dispatched).toEqual([]);
      expect(stamps).toEqual([]); // and last_at does not move, so /admin still shows the truth
    });
  }

  it("401s with the right secret presented to a deployment that has none configured", async () => {
    const { repo, stamps, deps } = setUp();
    const res = await handleTick({ ...deps, secret: undefined, authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(401);
    expect(repo.calls).toEqual([]);
    expect(stamps).toEqual([]);
  });
});

describe("handleTick — the run", () => {
  it("200s with {posts, newSuggestions} and nothing else", async () => {
    const { deps } = setUp();
    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ posts: 1, newSuggestions: 1 });
  });

  it("dispatches exactly the posts that owe somebody a send, and stamps the run after the work", async () => {
    // p2 was already proposed this crew AND already emailed them: nothing new, nothing pending.
    const { repo, dispatched, stamps, deps } = setUp({ posts: [post("p1"), post("p2")], pending: { p2: 0 } });
    repo.existing.set("p2", [{ personId: "a", rung: 1 }]);

    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 2, newSuggestions: 1 });
    expect(dispatched).toEqual(["p1"]);
    expect(stamps).toEqual([clockRow]);
  });

  /**
   * #128 AC 1 — the story's whole subject. A post whose rung did not move reaches NOBODY new, and
   * before #128 that alone decided the dispatch, so a suggestion left pending by the day's cap was
   * never handed back to `dispatchPending()` by the clock. The repo records every dispatch call,
   * so the assertion is on what the handler did rather than on what it answered.
   */
  it("dispatches a post that reached nobody new but still has a pending send (#128 AC 1)", async () => {
    const { repo, dispatched, deps } = setUp({ pending: { p1: 1 } });
    repo.existing.set("p1", [{ personId: "a", rung: 1 }]); // the pool's only crew, proposed earlier

    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 1, newSuggestions: 0 }); // nobody new, and that is the point
    expect(dispatched).toEqual(["p1"]);
  });

  /**
   * #128 AC 3 — the other side of the same condition, and the reason it is a `notified_at` read
   * rather than "does this post have suggestions". Widening it carelessly would turn the clock
   * into a full sweep of every open post every fifteen minutes; ninety-six of those a day is what
   * the cap cannot afford.
   */
  it("does not dispatch a post whose suggestions are all already notified (#128 AC 3)", async () => {
    const { repo, dispatched, deps } = setUp({ pending: { p1: 0 } });
    repo.existing.set("p1", [{ personId: "a", rung: 1 }]);

    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 1, newSuggestions: 0 });
    expect(dispatched).toEqual([]);
  });

  it("dispatches every post that owes a send, not merely the first (#128 AC 1)", async () => {
    const { repo, dispatched, deps } = setUp({ posts: [post("p1"), post("p2"), post("p3")], pending: { p2: 0 } });
    for (const id of ["p1", "p2", "p3"]) repo.existing.set(id, [{ personId: "a", rung: 1 }]);

    await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(dispatched).toEqual(["p1", "p3"]);
  });

  it("stamps a tick that found nothing to do — a quiet clock and a dead one must not look alike", async () => {
    const { dispatched, stamps, deps } = setUp({ posts: [] });
    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 0, newSuggestions: 0 });
    expect(dispatched).toEqual([]);
    expect(stamps).toEqual([clockRow]);
  });

  it("does not stamp a run that threw — the previous stamp stands and /admin goes on aging", async () => {
    const { stamps, deps, repo } = setUp();
    repo.openPosts = async () => {
      throw new Error("the database said no");
    };
    await expect(handleTick({ ...deps, authorization: `Bearer ${SECRET}` })).rejects.toThrow("the database said no");
    expect(stamps).toEqual([]);
  });
});

/**
 * #145 AC 2. Two clocks call the same route, and only the daily one may move `sweep_at`. The caller
 * is injected as the one header that decides it, exactly as the route hands it over.
 */
describe("handleTick — which clock called (#145)", () => {
  it("Vercel's cron moves both the daily stamp and last_at", async () => {
    const { stamps, deps } = setUp();
    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}`, cronSchedule: DAILY });
    expect(res.status).toBe(200);
    expect(stamps).toEqual([{ id: 1, last_at: NOW.toISOString(), sweep_at: NOW.toISOString() }]);
  });

  it("pg_cron moves only last_at, and sends no sweep_at key, so the daily stamp is left standing", async () => {
    const { stamps, deps } = setUp();
    await handleTick({ ...deps, authorization: `Bearer ${SECRET}`, cronSchedule: null });
    expect(stamps).toEqual([clockRow]);
    // Absent, not null: an upsert carrying `sweep_at: null` would ERASE the daily stamp.
    expect(Object.keys(stamps[0])).not.toContain("sweep_at");
  });

  it("a refused call carrying Vercel's header moves neither stamp", async () => {
    const { repo, stamps, deps } = setUp();
    const res = await handleTick({ ...deps, authorization: "Bearer not-the-secret", cronSchedule: DAILY });
    expect(res.status).toBe(401);
    expect(repo.calls).toEqual([]);
    expect(stamps).toEqual([]);
  });

  it("a sweep that threw part-way leaves the previous daily stamp standing too", async () => {
    const { stamps, deps, repo } = setUp();
    repo.openPosts = async () => {
      throw new Error("the database said no");
    };
    await expect(
      handleTick({ ...deps, authorization: `Bearer ${SECRET}`, cronSchedule: DAILY }),
    ).rejects.toThrow("the database said no");
    expect(stamps).toEqual([]);
  });
});

/**
 * #145 AC 3. The discriminator is the `x-vercel-cron-schedule` header, which Vercel documents on
 * every cron invocation, and not the method or the user agent (owner decision 2026-09-13; the
 * reasons are in tick-handler.ts). These name it, so a change of key is a visible change here.
 */
describe("tickCaller keys on the x-vercel-cron-schedule header", () => {
  it("the header the route reads is x-vercel-cron-schedule", () => {
    expect(VERCEL_CRON_HEADER).toBe("x-vercel-cron-schedule");
  });

  it("a request carrying it is Vercel's cron", () => {
    expect(tickCaller(DAILY)).toBe("vercel-cron");
  });

  it("a request without it is not — pg_cron's POST, or anyone else holding the secret", () => {
    expect(tickCaller(null)).toBe("other");
  });

  it("an empty or blank header is not Vercel's cron either", () => {
    expect(tickCaller("")).toBe("other");
    expect(tickCaller("   ")).toBe("other");
  });
});
