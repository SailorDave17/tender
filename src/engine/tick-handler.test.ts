import { describe, expect, it } from "vitest";
import type { Crew, Rung } from "./ladder";
import { handleTick } from "./tick-handler";
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
  async setRung(postId: string, rung: Rung) {
    this.calls.push(`setRung(${postId},${rung})`);
  }
  async insertSuggestions(rows: NewSuggestion[]) {
    this.calls.push(`insertSuggestions(${rows.length})`);
  }
}

function setUp(over: { pool?: Crew[]; posts?: TickPost[] } = {}) {
  const repo = new RecordingRepo();
  repo.posts = over.posts ?? [post("p1")];
  repo.pool = over.pool ?? [{ id: "a", rating: 2, hulls: ["Thistle"], available: true }];
  const dispatched: string[] = [];
  const stamps: Date[] = [];
  const deps = {
    secret: SECRET,
    repo,
    dispatch: async (p: TickPost) => {
      dispatched.push(p.id);
    },
    recordRun: async (now: Date) => {
      stamps.push(now);
    },
    now: NOW,
  };
  return { repo, dispatched, stamps, deps };
}

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

  it("dispatches exactly the posts that reached somebody new, and stamps the run after the work", async () => {
    const { repo, dispatched, stamps, deps } = setUp({ posts: [post("p1"), post("p2")] });
    repo.existing.set("p2", [{ personId: "a", rung: 1 }]); // p2 already told this crew

    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 2, newSuggestions: 1 });
    expect(dispatched).toEqual(["p1"]);
    expect(stamps).toEqual([NOW]);
  });

  it("stamps a tick that found nothing to do — a quiet clock and a dead one must not look alike", async () => {
    const { dispatched, stamps, deps } = setUp({ posts: [] });
    const res = await handleTick({ ...deps, authorization: `Bearer ${SECRET}` });
    expect(res.body).toEqual({ posts: 0, newSuggestions: 0 });
    expect(dispatched).toEqual([]);
    expect(stamps).toEqual([NOW]);
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
