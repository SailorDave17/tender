import { describe, expect, it } from "vitest";
import type { Crew, Rung } from "./ladder";
import { lastTickLabel, runTick, type NewSuggestion, type Suggested, type TickPost, type TickRepo } from "./tick";

/**
 * runTick()'s BOOKKEEPING, over a recording repo — what it counts, in what order it asks, and
 * which calls it does not make.
 *
 * The behaviour fixtures AC 2, 3 and 4 name are NOT here: they run over real SQL in
 * `test/tick.test.ts`, because their claims are about 0010's primary key and its monotone
 * trigger, and a repo written by the same hand as the code under test cannot disagree with me
 * about either (cairn: a-fake-cannot-disagree-with-its-author-2026-08-24). What a recorder can
 * say that a database cannot is which calls were NEVER made — an update that matches nothing and
 * an update never issued leave the same rows behind.
 */

const DATE = "22222222-2222-4222-8222-222222222222";
const RACE = new Date("2027-06-13T17:00:00Z");
const NOW = new Date("2027-06-06T12:00:00Z"); // a week out: the clock opens nothing

const crew = (id: string, rating: 1 | 2 | 3 | 4, hulls: string[] = []): Crew => ({ id, rating, hulls, available: true });

function post(id: string, over: Partial<TickPost> = {}): TickPost {
  return {
    id,
    raceDateId: DATE,
    boatClass: "Thistle",
    boatName: "Blue Moon",
    minimum: 2,
    startsAt: RACE.toISOString(),
    dateTitle: "Spring Series 3",
    currentRung: 1,
    closedAt: null,
    ...over,
  };
}

class RecordingRepo implements TickRepo {
  calls: string[] = [];
  posts: TickPost[] = [];
  pool: Crew[] = [];
  existing: Suggested[] = [];
  rungsSet: { postId: string; rung: Rung }[] = [];
  inserted: NewSuggestion[] = [];

  async openPosts(now: Date) {
    this.calls.push(`openPosts(${now.toISOString()})`);
    return this.posts;
  }
  async poolFor(raceDateId: string) {
    this.calls.push(`poolFor(${raceDateId})`);
    return this.pool;
  }
  async suggestionsFor(postId: string) {
    this.calls.push(`suggestionsFor(${postId})`);
    return this.existing;
  }
  async setRung(postId: string, rung: Rung) {
    this.calls.push(`setRung(${postId},${rung})`);
    this.rungsSet.push({ postId, rung });
  }
  async insertSuggestions(rows: NewSuggestion[]) {
    this.calls.push(`insertSuggestions(${rows.length})`);
    this.inserted.push(...rows);
  }
}

describe("runTick — what it counts", () => {
  it("`posts` is the open posts EVALUATED, not the ones that changed", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1"), post("p2")];
    repo.pool = [crew("a", 2, ["Thistle"])];
    repo.existing = [{ personId: "a", rung: 1 }]; // already suggested on both: nothing is new

    const result = await runTick(repo, NOW);
    expect(result.posts).toBe(2);
    expect(result.newSuggestions).toBe(0);
    expect(repo.rungsSet).toEqual([]);
  });

  it("`newSuggestions` sums the crew newly reached across posts", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1"), post("p2")];
    repo.pool = [crew("a", 2, ["Thistle"]), crew("b", 3)];

    const result = await runTick(repo, NOW);
    expect(result.newSuggestions).toBe(4); // two crew on each of two posts
    expect(result.ticked.map((t) => t.reached.map((r) => r.personId))).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("carries the post itself into the result, so the caller dispatches without re-reading it", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1")];
    repo.pool = [crew("a", 2, ["Thistle"])];

    const result = await runTick(repo, NOW);
    expect(result.ticked[0].post).toBe(repo.posts[0]);
  });

  it("evaluates an empty board without asking anything else", async () => {
    const repo = new RecordingRepo();
    const result = await runTick(repo, NOW);
    expect(result).toEqual({ posts: 0, newSuggestions: 0, ticked: [] });
    expect(repo.calls).toEqual([`openPosts(${NOW.toISOString()})`]);
  });
});

describe("runTick — the calls it does and does not make", () => {
  it("does not write a rung when the open rung is the stored one — the trigger is a backstop, not the mechanism", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1", { currentRung: 2 })];
    repo.pool = [crew("a", 2, ["Thistle"]), crew("b", 2, ["Flying Scot"])];

    await runTick(repo, NOW);
    // suggest() answers 1 here (a rung-1 crew is available); the stored 2 wins and stands.
    expect(repo.calls.filter((c) => c.startsWith("setRung"))).toEqual([]);
    expect(repo.inserted.map((r) => `${r.personId}:${r.rung}`)).toEqual(["a:1", "b:2"]);
  });

  it("reads what is already suggested BEFORE inserting, and inserts every candidate so the key decides", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1")];
    repo.pool = [crew("a", 2, ["Thistle"]), crew("b", 2, ["Thistle"])];
    repo.existing = [{ personId: "a", rung: 1 }];

    const result = await runTick(repo, NOW);
    expect(repo.calls.indexOf("suggestionsFor(p1)")).toBeLessThan(repo.calls.indexOf("insertSuggestions(2)"));
    // Both go to the insert — the already-present pair is the database's problem, not a filter
    // here — while only the new one is reported and dispatched on.
    expect(repo.inserted.map((r) => r.personId)).toEqual(["a", "b"]);
    expect(result.ticked[0].reached.map((r) => r.personId)).toEqual(["b"]);
    expect(result.newSuggestions).toBe(1);
  });

  it("skips the insert entirely when nobody is available", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1")];
    await runTick(repo, NOW);
    expect(repo.calls.filter((c) => c.startsWith("insertSuggestions"))).toEqual([]);
  });

  it("an unavailable crew is never suggested, whatever their rung would be", async () => {
    const repo = new RecordingRepo();
    repo.posts = [post("p1")];
    repo.pool = [{ ...crew("a", 3, ["Thistle"]), available: false }, crew("b", 2, ["Thistle"])];
    const result = await runTick(repo, NOW);
    expect(result.ticked[0].reached.map((r) => r.personId)).toEqual(["b"]);
  });
});

describe("lastTickLabel", () => {
  const at = (iso: string) => new Date(iso);

  it("says 'never' before the first tick", () => {
    expect(lastTickLabel(null, at("2027-06-06T12:00:00Z"))).toBe("never");
  });

  it("counts whole minutes, and keeps counting in minutes when the clock is long dead", () => {
    expect(lastTickLabel(at("2027-06-06T11:57:00Z"), at("2027-06-06T12:00:00Z"))).toBe("3 min ago");
    expect(lastTickLabel(at("2027-06-06T11:59:30Z"), at("2027-06-06T12:00:00Z"))).toBe("just now");
    expect(lastTickLabel(at("2027-06-05T12:00:00Z"), at("2027-06-06T12:00:00Z"))).toBe("1440 min ago");
  });

  it("reads a stamp from the future as 'just now' rather than a negative count", () => {
    expect(lastTickLabel(at("2027-06-06T12:00:30Z"), at("2027-06-06T12:00:00Z"))).toBe("just now");
    expect(lastTickLabel(at("2027-06-06T13:00:00Z"), at("2027-06-06T12:00:00Z"))).toBe("just now");
  });
});
