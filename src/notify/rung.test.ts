import { describe, expect, it } from "vitest";
import type { Crew, Rung } from "@/engine/ladder";
import type { Message, Transport } from "@/email/send";
import {
  EMAIL_SKIP_AT,
  KIND_RUNG_EMAIL,
  KIND_RUNG_EMAIL_NO_ADDRESS,
  KIND_RUNG_EMAIL_SKIPPED_CAP,
  emailDayStart,
  notifyRung,
  openRung,
  rungMessage,
  type LogEntry,
  type RungPost,
  type RungStore,
} from "./rung";

/**
 * notifyRung() against an in-memory store and a fake transport (story #23 AC 2, 3, 5, 6).
 * The store records every write so a test can count suggestion rows, log rows and
 * notified_at marks exactly; the transport records every recipient, and can be told to refuse
 * one address. `now` is pinned a week before the race so the clock opens nothing.
 */

const RACE = new Date("2027-06-13T17:00:00Z"); // Sunday 1 pm in Ohio, a week out
const NOW = new Date("2027-06-06T12:00:00Z");
const POST = "11111111-1111-4111-8111-111111111111";
const DATE = "22222222-2222-4222-8222-222222222222";

const crew = (id: string, rating: 1 | 2 | 3, hulls: string[] = []): Crew => ({ id, rating, hulls, available: true });
const email = (id: string) => `${id}@example.org`;

type Row = { postId: string; personId: string; rung: Rung; notifiedAt: Date | null };

class MemoryStore implements RungStore {
  posts = new Map<string, RungPost>();
  pools = new Map<string, Crew[]>();
  /** Who has a contact row; a crew id absent here has no email. */
  emails = new Map<string, string>();
  suggestions: Row[] = [];
  logs: LogEntry[] = [];
  /** Seeded as if earlier sends had happened today. */
  sentToday = 0;
  raised: { postId: string; rung: Rung }[] = [];

  async post(postId: string) {
    return this.posts.get(postId) ?? null;
  }
  async pool(raceDateId: string) {
    return this.pools.get(raceDateId) ?? [];
  }
  async raiseRung(postId: string, rung: Rung) {
    const p = this.posts.get(postId)!;
    if (rung < p.currentRung) throw new Error("0010 would refuse a decrease");
    this.posts.set(postId, { ...p, currentRung: rung });
    this.raised.push({ postId, rung });
  }
  async addSuggestions(rows: { postId: string; personId: string; rung: Rung }[]) {
    for (const r of rows) {
      if (this.suggestions.some((s) => s.postId === r.postId && s.personId === r.personId)) continue;
      this.suggestions.push({ ...r, notifiedAt: null });
    }
  }
  async pending(postId: string) {
    return this.suggestions
      .filter((s) => s.postId === postId && s.notifiedAt === null)
      .map((s) => ({ personId: s.personId, rung: s.rung, email: this.emails.get(s.personId) ?? null }));
  }
  async emailsSentToday() {
    return this.sentToday + this.logs.filter((l) => l.kind === KIND_RUNG_EMAIL).length;
  }
  async log(entry: LogEntry) {
    this.logs.push(entry);
  }
  async markNotified(postId: string, personId: string, at: Date) {
    const s = this.suggestions.find((x) => x.postId === postId && x.personId === personId)!;
    s.notifiedAt = at;
  }
}

class FakeTransport implements Transport {
  sent: Message[] = [];
  refuse = new Set<string>();
  async send(message: Message) {
    if (this.refuse.has(message.to)) throw new Error("provider said no");
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
}

function setUp(pool: Crew[], opts: { currentRung?: Rung; closed?: boolean; noEmailFor?: string[] } = {}) {
  const store = new MemoryStore();
  store.posts.set(POST, {
    id: POST,
    raceDateId: DATE,
    boatClass: "Thistle",
    boatName: "Blue Moon",
    minimum: 2,
    startsAt: RACE.toISOString(),
    dateTitle: "Spring Series 3",
    currentRung: opts.currentRung ?? 1,
    closedAt: opts.closed ? NOW.toISOString() : null,
  });
  store.pools.set(DATE, pool);
  for (const c of pool) if (!opts.noEmailFor?.includes(c.id)) store.emails.set(c.id, email(c.id));
  const transport = new FakeTransport();
  const deps = { store, transport, now: NOW, siteUrl: "https://tender.test" };
  return { store, transport, deps };
}

/** Ten crew: three on rung 1 for a Thistle at minimum 2, four on rung 2 (other hulls), three on rung 3 (under the minimum). */
function tenCrew(): Crew[] {
  return [
    crew("r1a", 2, ["Thistle"]),
    crew("r1b", 3),
    crew("r1c", 3, ["Thistle", "Flying Scot"]),
    crew("r2a", 2, ["Flying Scot"]),
    crew("r2b", 3, ["Interlake"]),
    crew("r2c", 2, ["Lightning"]),
    crew("r2d", 2, ["Interlake"]),
    crew("r3a", 1),
    crew("r3b", 1, ["Thistle"]),
    crew("r3c", 1, ["Flying Scot"]),
  ];
}

describe("notifyRung — the open rung's crew are emailed, exactly, once (AC 2)", () => {
  it("emails the 3 of 10 on the open rung, writes 3 log rows and 3 suggestion rows, and a second run sends zero", async () => {
    const { store, transport, deps } = setUp(tenCrew());
    const first = await notifyRung(POST, deps);
    expect(first).toEqual({ rung: 1, suggested: 3, sent: 3, skippedCap: 0, failed: 0 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["r1a", "r1b", "r1c"].map(email));
    expect(store.logs).toHaveLength(3);
    expect(store.logs.every((l) => l.kind === KIND_RUNG_EMAIL && l.channel === "email" && l.providerId !== null && l.error === null)).toBe(true);
    expect(store.suggestions.map((s) => [s.personId, s.rung, s.notifiedAt]).sort()).toEqual([
      ["r1a", 1, NOW],
      ["r1b", 1, NOW],
      ["r1c", 1, NOW],
    ]);
    expect(store.raised).toEqual([]); // the stored rung 1 was already the open rung

    const second = await notifyRung(POST, deps);
    expect(second).toEqual({ rung: 1, suggested: 3, sent: 0, skippedCap: 0, failed: 0 });
    expect(transport.sent).toHaveLength(3);
    expect(store.logs).toHaveLength(3);
    expect(store.suggestions).toHaveLength(3);
  });

  it("never emails the whole pool: with rung 1 empty the post opens at rung 2, and rung 3 stays quiet", async () => {
    const pool = tenCrew().filter((c) => !c.id.startsWith("r1"));
    const { store, transport, deps } = setUp(pool);
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 2, suggested: 4, sent: 4, skippedCap: 0, failed: 0 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["r2a", "r2b", "r2c", "r2d"].map(email));
    expect(store.raised).toEqual([{ postId: POST, rung: 2 }]); // the widening is persisted
    expect(store.posts.get(POST)!.currentRung).toBe(2);
  });

  it("does nothing on a closed post, and nothing on a post it cannot find", async () => {
    const { store, transport, deps } = setUp(tenCrew(), { closed: true });
    expect(await notifyRung(POST, deps)).toBeNull();
    expect(await notifyRung("33333333-3333-4333-8333-333333333333", deps)).toBeNull();
    expect(transport.sent).toEqual([]);
    expect(store.suggestions).toEqual([]);
    expect(store.logs).toEqual([]);
  });
});

describe("notifyRung — a crew marking the day after the post opened (AC 3)", () => {
  it("gets one suggestion row and one email from the toggle; nobody already told is told again", async () => {
    const { store, transport, deps } = setUp(tenCrew());
    await notifyRung(POST, deps);
    expect(transport.sent).toHaveLength(3);

    // A new rung-1 crew marks the day: the pool grows by one.
    const late = crew("late", 3, ["Thistle"]);
    store.pools.get(DATE)!.push(late);
    store.emails.set("late", email("late"));
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 1, suggested: 4, sent: 1, skippedCap: 0, failed: 0 });
    expect(transport.sent).toHaveLength(4);
    expect(transport.sent[3].to).toBe(email("late"));
    expect(store.suggestions.filter((s) => s.personId === "late")).toHaveLength(1);
    expect(store.logs).toHaveLength(4);
  });

  it("a crew below the open rung who marks the day is neither suggested nor emailed", async () => {
    const { store, transport, deps } = setUp(tenCrew());
    await notifyRung(POST, deps);
    store.pools.get(DATE)!.push(crew("late2", 2, ["Interlake"])); // rung 2 on a rung-1 post
    store.emails.set("late2", email("late2"));
    const r = await notifyRung(POST, deps);
    expect(r!.sent).toBe(0);
    expect(store.suggestions.some((s) => s.personId === "late2")).toBe(false);
    expect(transport.sent).toHaveLength(3);
  });
});

describe("notifyRung — the stored rung wins over a narrower computed one (AC 4, the write side)", () => {
  it("a post stored at rung 2 stays open at 2 when a rung-1 crew appears, and that crew is still proposed", async () => {
    // Stored 2 (say, emptiness widened it yesterday); today a rung-1 crew is in the pool, so
    // suggest() would say 1. The rung is 2, nothing is raised or lowered, and everyone on or
    // above 2 is proposed — the rung-1 crew included.
    const { store, transport, deps } = setUp(tenCrew(), { currentRung: 2 });
    const r = await notifyRung(POST, deps);
    expect(r!.rung).toBe(2);
    expect(store.raised).toEqual([]);
    expect(store.posts.get(POST)!.currentRung).toBe(2);
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["r1a", "r1b", "r1c", "r2a", "r2b", "r2c", "r2d"].map(email));
  });

  it("openRung() is max(stored, computed)", () => {
    expect(openRung(1, 1)).toBe(1);
    expect(openRung(2, 1)).toBe(2);
    expect(openRung(1, 3)).toBe(3);
    expect(openRung(3, 2)).toBe(3);
  });
});

describe("notifyRung — the daily cap (AC 5)", () => {
  it(`at ${EMAIL_SKIP_AT} email rows today, nothing is sent, each skip is logged as ${KIND_RUNG_EMAIL_SKIPPED_CAP}, and nobody is marked notified`, async () => {
    const { store, transport, deps } = setUp(tenCrew());
    store.sentToday = EMAIL_SKIP_AT;
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 1, suggested: 3, sent: 0, skippedCap: 3, failed: 0 });
    expect(transport.sent).toEqual([]);
    expect(store.logs.map((l) => l.kind)).toEqual([KIND_RUNG_EMAIL_SKIPPED_CAP, KIND_RUNG_EMAIL_SKIPPED_CAP, KIND_RUNG_EMAIL_SKIPPED_CAP]);
    expect(store.logs.every((l) => l.toEmail !== null && l.providerId === null && l.error === null)).toBe(true);
    expect(store.suggestions.every((s) => s.notifiedAt === null)).toBe(true); // tomorrow's run sends them
  });

  it("one short of the cap sends exactly one and skips the rest", async () => {
    const { store, transport, deps } = setUp(tenCrew());
    store.sentToday = EMAIL_SKIP_AT - 1;
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 1, suggested: 3, sent: 1, skippedCap: 2, failed: 0 });
    expect(transport.sent).toHaveLength(1);
  });

  it("emailDayStart is the UTC midnight of the day the clock is in", () => {
    expect(emailDayStart(new Date("2027-06-06T23:59:59Z")).toISOString()).toBe("2027-06-06T00:00:00.000Z");
    expect(emailDayStart(new Date("2027-06-07T00:00:00Z")).toISOString()).toBe("2027-06-07T00:00:00.000Z");
  });
});

describe("notifyRung — one refused send does not stop the others (AC 6)", () => {
  it("sends the rest, logs the failure with its error, leaves the failed one unmarked, and retries it alone next run", async () => {
    const { store, transport, deps } = setUp(tenCrew());
    transport.refuse.add(email("r1b"));
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 1, suggested: 3, sent: 2, skippedCap: 0, failed: 1 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["r1a", "r1c"].map(email));
    const failed = store.logs.find((l) => l.personId === "r1b")!;
    expect(failed).toMatchObject({ kind: KIND_RUNG_EMAIL, providerId: null, error: "provider said no" });
    expect(store.suggestions.find((s) => s.personId === "r1b")!.notifiedAt).toBeNull();
    expect(store.suggestions.filter((s) => s.personId !== "r1b").every((s) => s.notifiedAt === NOW)).toBe(true);

    transport.refuse.clear();
    const again = await notifyRung(POST, deps);
    expect(again).toEqual({ rung: 1, suggested: 3, sent: 1, skippedCap: 0, failed: 0 });
    expect(transport.sent.map((m) => m.to)).toEqual(["r1a", "r1c", "r1b"].map(email));
  });

  it("a suggested crew with no contact row is logged as no-address and not counted as an attempt", async () => {
    const { store, transport, deps } = setUp(tenCrew(), { noEmailFor: ["r1a"] });
    const r = await notifyRung(POST, deps);
    expect(r).toEqual({ rung: 1, suggested: 3, sent: 2, skippedCap: 0, failed: 1 });
    expect(transport.sent).toHaveLength(2);
    expect(store.logs.find((l) => l.personId === "r1a")).toMatchObject({ kind: KIND_RUNG_EMAIL_NO_ADDRESS, toEmail: null });
    expect(await store.emailsSentToday()).toBe(2);
  });
});

describe("rungMessage — what the crew reads", () => {
  it("names the boat, the class, the day in Ohio time, the minimum, and links to the post on the given origin", () => {
    const { store } = setUp([]);
    const m = rungMessage(store.posts.get(POST)!, "crew@example.org", "https://tender.madcowsailing.com");
    expect(m.to).toBe("crew@example.org");
    expect(m.subject).toBe("Crew needed: Blue Moon (Thistle), Sun, Jun 13, 1:00 PM");
    expect(m.text).toContain("Spring Series 3");
    expect(m.text).toContain("Minimum competence: can hike and trim");
    expect(m.text).toContain(`https://tender.madcowsailing.com/post/${POST}`);
  });
});
