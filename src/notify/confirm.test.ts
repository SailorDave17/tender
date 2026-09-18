import { describe, expect, it } from "vitest";
import { whenLabel } from "@/dates/race-date";
import type { Message, Transport } from "@/email/send";
import type { MorningMatch } from "@/engine/morningOf";
import { confirmPush, confirmedPush } from "@/push/payload";
import type { PushOutcome, PushTarget, PushTransport } from "@/push/send";
import {
  KIND_CONFIRMED,
  KIND_CONFIRMED_PUSH,
  KIND_CONFIRMED_SKIPPED_CAP,
  KIND_MORNING_OF,
  KIND_MORNING_OF_PUSH,
  KIND_MORNING_OF_PUSH_GONE,
  KIND_MORNING_OF_SKIPPED_CAP,
  confirmedMessage,
  notifyConfirmed,
  remindCrew,
  reminderMessage,
  type ConfirmMatch,
  type ConfirmStore,
} from "./confirm";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * remindCrew() and notifyConfirmed() against an in-memory store and fake transports (story #37
 * AC 2, AC 3). The pglite half — that the reminder is asked of the right matches on the right
 * morning and of nobody twice — is test/morning-of.test.ts's; this file holds what each call
 * SENDS, logs and marks, per outcome.
 *
 * The push fake records what it was called with, not merely that it was called: "email
 * skipped, push sent" and "both sent" are the same observation to a fake that drops its
 * arguments (cairn: a-fake-that-drops-an-argument-makes-two-behaviours-one).
 */

const MATCH = "11111111-1111-4111-8111-111111111111";
const POST = "33333333-3333-4333-8333-333333333333";
const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2027-06-13T10:00:00Z"); // 06:00 EDT on race day
const SITE = "https://tender.example.org";

const post = (): RungPost => ({
  id: POST,
  raceDateId: "44444444-4444-4444-8444-444444444444",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: "2027-06-06T11:00:00Z", // a matched post is closed
});

const morning = (): MorningMatch => ({ id: MATCH, skipperId: SKIPPER, crewId: CREW, post: post() });

class MemoryStore implements ConfirmStore {
  matches = new Map<string, ConfirmMatch>();
  posts = new Map<string, RungPost>();
  names = new Map<string, string>();
  emails = new Map<string, string>();
  targets = new Map<string, (PushTarget & { id: string })[]>();
  logs: LogEntry[] = [];
  deleted: string[] = [];
  reminded: { matchId: string; at: Date }[] = [];
  sentToday = 0;

  async match(id: string) {
    return this.matches.get(id) ?? null;
  }
  async post(id: string) {
    return this.posts.get(id) ?? null;
  }
  async name(id: string) {
    return this.names.get(id) ?? null;
  }
  async email(id: string) {
    return this.emails.get(id) ?? null;
  }
  async pushTargets(id: string) {
    return this.targets.get(id) ?? [];
  }
  async deleteSubscription(id: string) {
    this.deleted.push(id);
  }
  async emailsSentToday() {
    return this.sentToday;
  }
  async log(entry: LogEntry) {
    this.logs.push(entry);
  }
  async markReminded(matchId: string, at: Date) {
    this.reminded.push({ matchId, at });
  }
}

class FakeTransport implements Transport {
  sent: Message[] = [];
  refuse = false;
  async send(message: Message) {
    if (this.refuse) throw new Error("provider said no");
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
}

class FakePush implements PushTransport {
  sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[] = [];
  outcomes = new Map<string, PushOutcome>();
  async send(target: PushTarget, payload: { title: string; body: string; url: string; tag: string }) {
    this.sent.push({ endpoint: target.endpoint, payload });
    return this.outcomes.get(target.endpoint) ?? ({ ok: true } as PushOutcome);
  }
}

const target = (id: string) => ({ id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a" });

function setUp() {
  const store = new MemoryStore();
  store.matches.set(MATCH, { id: MATCH, postId: POST, skipperId: SKIPPER, crewId: CREW, status: "confirmed" });
  store.posts.set(POST, post());
  store.names.set(CREW, "Cy");
  store.names.set(SKIPPER, "Sam");
  store.emails.set(CREW, "cy@example.org");
  store.emails.set(SKIPPER, "sam@example.org");
  const transport = new FakeTransport();
  const push = new FakePush();
  const deps = (p?: FakePush) => ({ store, transport, push: p, now: NOW, siteUrl: SITE });
  return { store, transport, push, deps };
}

describe("remindCrew — the race-morning ask (AC 2)", () => {
  it("emails the crew a Confirm link, logs morning_of, and marks the match reminded at the tick's clock", async () => {
    const { store, transport, deps } = setUp();
    const r = await remindCrew(morning(), deps());
    expect(r).toMatchObject({ emailed: true, skippedCap: false, failed: false, pushed: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe("cy@example.org");
    expect(transport.sent[0].subject).toContain("Confirm for today");
    expect(transport.sent[0].text).toContain(`${SITE}/post/${POST}`);
    expect(store.logs).toEqual([
      { kind: KIND_MORNING_OF, channel: "email", personId: CREW, toEmail: "cy@example.org", postId: POST, providerId: "msg-1", error: null },
    ]);
    expect(store.reminded).toEqual([{ matchId: MATCH, at: NOW }]);
  });

  it("pushes every device the crew has with the confirm payload, logs each, and still emails", async () => {
    const { store, transport, push, deps } = setUp();
    store.targets.set(CREW, [target("d1"), target("d2")]);
    const r = await remindCrew(morning(), deps(push));
    expect(r).toMatchObject({ pushed: 2, pushFailed: 0, pruned: 0, emailed: true });
    expect(push.sent.map((s) => s.endpoint)).toEqual(["https://push.example/d1", "https://push.example/d2"]);
    expect(push.sent[0].payload).toEqual(confirmPush(post())); // the confirm payload, not the rung one
    expect(store.logs.filter((l) => l.kind === KIND_MORNING_OF_PUSH)).toHaveLength(2);
    expect(transport.sent).toHaveLength(1);
  });

  it("a gone subscription is deleted and logged; an ordinary push failure leaves the row and the email alone", async () => {
    const { store, push, deps } = setUp();
    store.targets.set(CREW, [target("dead"), target("flaky"), target("live")]);
    push.outcomes.set("https://push.example/dead", { ok: false, gone: true, error: "410" });
    push.outcomes.set("https://push.example/flaky", { ok: false, gone: false, error: "503" });
    const r = await remindCrew(morning(), deps(push));
    expect(r).toMatchObject({ pushed: 1, pushFailed: 1, pruned: 1, emailed: true });
    expect(store.deleted).toEqual(["dead"]);
    expect(store.logs.find((l) => l.kind === KIND_MORNING_OF_PUSH_GONE)?.providerId).toBe("https://push.example/dead");
  });

  it("at the daily cap the email is skipped and logged, the push still goes, and the match is STILL marked reminded", async () => {
    // Owner decision 2026-09-18: no retry. The cap clears at UTC midnight — 8 pm in Ohio — after
    // the race, so a retry could only spend more of tomorrow's cap on a reminder nobody needs.
    const { store, transport, push, deps } = setUp();
    store.targets.set(CREW, [target("d1")]);
    store.sentToday = EMAIL_SKIP_AT;
    const r = await remindCrew(morning(), deps(push));
    expect(r).toMatchObject({ emailed: false, skippedCap: true, pushed: 1 });
    expect(transport.sent).toHaveLength(0);
    expect(store.logs.filter((l) => l.channel === "email")).toEqual([
      { kind: KIND_MORNING_OF_SKIPPED_CAP, channel: "email", personId: CREW, toEmail: "cy@example.org", postId: POST, providerId: null, error: null },
    ]);
    expect(store.reminded).toEqual([{ matchId: MATCH, at: NOW }]);
  });

  it("one below the cap still sends", async () => {
    const { store, transport, deps } = setUp();
    store.sentToday = EMAIL_SKIP_AT - 1;
    await remindCrew(morning(), deps());
    expect(transport.sent).toHaveLength(1);
  });

  it("a refused send is logged with its error, reports failed, and the match is still marked reminded", async () => {
    const { store, transport, deps } = setUp();
    transport.refuse = true;
    const r = await remindCrew(morning(), deps());
    expect(r).toMatchObject({ emailed: false, failed: true });
    const log = store.logs.find((l) => l.kind === KIND_MORNING_OF);
    expect(log?.error).toBe("provider said no");
    expect(log?.providerId).toBeNull();
    expect(store.reminded).toHaveLength(1);
  });

  it("a crew with no contact row is logged, not thrown, and still marked reminded", async () => {
    const { store, transport, deps } = setUp();
    store.emails.delete(CREW);
    const r = await remindCrew(morning(), deps());
    expect(r).toMatchObject({ emailed: false, failed: true });
    expect(store.logs.find((l) => l.kind === KIND_MORNING_OF)?.error).toBe("no contact email");
    expect(transport.sent).toHaveLength(0);
    expect(store.reminded).toHaveLength(1);
  });

  it("no push transport (no VAPID keys) degrades to email alone", async () => {
    const { store, transport, deps } = setUp();
    store.targets.set(CREW, [target("d1")]);
    const r = await remindCrew(morning(), deps(undefined));
    expect(r).toMatchObject({ pushed: 0, emailed: true });
    expect(transport.sent).toHaveLength(1);
  });

  it("marks AFTER sending — a store that cannot log leaves the match un-reminded for the next tick", async () => {
    const { store, deps } = setUp();
    store.log = async () => {
      throw new Error("log said no");
    };
    await expect(remindCrew(morning(), deps())).rejects.toThrow("log said no");
    expect(store.reminded).toEqual([]);
  });
});

describe("notifyConfirmed — the skipper is told (AC 3)", () => {
  it("emails and pushes the SKIPPER, naming the crew, and logs kind confirmed", async () => {
    const { store, transport, push, deps } = setUp();
    store.targets.set(SKIPPER, [target("s1")]);
    const r = await notifyConfirmed(MATCH, deps(push));
    expect(r).toMatchObject({ emailed: true, pushed: 1 });
    expect(transport.sent[0].to).toBe("sam@example.org");
    expect(transport.sent[0].subject).toBe(`Cy confirmed: Blue Moon, ${whenLabel(post().startsAt)}`);
    expect(push.sent[0].payload).toEqual(confirmedPush(post(), "Cy"));
    expect(store.logs.filter((l) => l.kind === KIND_CONFIRMED)).toHaveLength(1);
    expect(store.logs.filter((l) => l.kind === KIND_CONFIRMED_PUSH)).toHaveLength(1);
    expect(store.reminded).toEqual([]); // this is not the reminder; nothing is marked
  });

  it("answers null and sends nothing for a missing match, a post that is gone, or a match not confirmed", async () => {
    const { store, transport, deps } = setUp();
    expect(await notifyConfirmed("99999999-9999-4999-8999-999999999999", deps())).toBeNull();
    store.matches.set(MATCH, { ...store.matches.get(MATCH)!, status: "accepted" });
    expect(await notifyConfirmed(MATCH, deps())).toBeNull(); // read back, not trusted from the caller
    store.matches.set(MATCH, { ...store.matches.get(MATCH)!, status: "confirmed" });
    store.posts.delete(POST);
    expect(await notifyConfirmed(MATCH, deps())).toBeNull();
    expect(transport.sent).toHaveLength(0);
    expect(store.logs).toHaveLength(0);
  });

  it("at the cap the email is skipped and logged confirmed_skipped_cap", async () => {
    const { store, transport, deps } = setUp();
    store.sentToday = EMAIL_SKIP_AT;
    const r = await notifyConfirmed(MATCH, deps());
    expect(r).toMatchObject({ emailed: false, skippedCap: true });
    expect(transport.sent).toHaveLength(0);
    expect(store.logs.map((l) => l.kind)).toEqual([KIND_CONFIRMED_SKIPPED_CAP]);
  });

  it("a crew whose name row is gone is still announced, as 'Your crew'", async () => {
    const { store, transport, deps } = setUp();
    store.names.delete(CREW);
    await notifyConfirmed(MATCH, deps());
    expect(transport.sent[0].subject).toContain("Your crew confirmed");
  });
});

describe("the copy", () => {
  it("reminderMessage says it is race day, names the boat and the start, and links the post", () => {
    const m = reminderMessage(post(), "cy@example.org", SITE);
    expect(m.subject).toBe(`Confirm for today: Blue Moon, ${whenLabel(post().startsAt)}`);
    expect(m.text).toContain("You are crewing Blue Moon (Thistle) for Spring Series 3");
    expect(m.text).toContain(`${SITE}/post/${POST}`);
  });

  it("confirmedMessage names the crew and links the post", () => {
    const m = confirmedMessage(post(), "Cy", "sam@example.org", SITE);
    expect(m.text).toContain("Cy confirmed for Blue Moon (Thistle), Spring Series 3");
    expect(m.text).toContain(`${SITE}/post/${POST}`);
  });
});
