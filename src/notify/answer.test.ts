import { describe, expect, it } from "vitest";
import { whenLabel } from "@/dates/race-date";
import type { Message, Transport } from "@/email/send";
import { answerPush, rungPush } from "@/push/payload";
import type { PushOutcome, PushTarget, PushTransport } from "@/push/send";
import {
  ANSWER_EMAIL_WINDOW_MS,
  KIND_ANSWER,
  KIND_ANSWER_PUSH,
  KIND_ANSWER_PUSH_GONE,
  KIND_ANSWER_SUPPRESSED,
  answerMessage,
  notifyAnswer,
  type AnswerPost,
  type AnswerStore,
} from "./answer";
import type { LogEntry } from "./rung";

/**
 * notifyAnswer() against an in-memory store and fake transports (story #24, all three ACs).
 * The clock is injected and every window case moves it explicitly — AC 2 names the fake clock
 * as the instrument, because a 15-minute wait has no place in a test.
 */

const POST = "11111111-1111-4111-8111-111111111111";
const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2027-06-06T12:00:00Z");
const SITE = "https://tender.example.org";

const post = (over: Partial<AnswerPost> = {}): AnswerPost => ({
  id: POST,
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: null,
  skipperId: SKIPPER,
  ...over,
});

class MemoryStore implements AnswerStore {
  posts = new Map<string, AnswerPost>();
  answers = 0;
  lastEmail: Date | null = null;
  emails = new Map<string, string>();
  targets = new Map<string, (PushTarget & { id: string })[]>();
  logs: LogEntry[] = [];
  deleted: string[] = [];

  async post(postId: string) {
    return this.posts.get(postId) ?? null;
  }
  async liveAnswers() {
    return this.answers;
  }
  async lastAnswerEmailAt() {
    return this.lastEmail;
  }
  async email(personId: string) {
    return this.emails.get(personId) ?? null;
  }
  async pushTargets(personId: string) {
    return this.targets.get(personId) ?? [];
  }
  async deleteSubscription(id: string) {
    this.deleted.push(id);
  }
  async log(entry: LogEntry) {
    this.logs.push(entry);
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

/**
 * Answers what it is told per endpoint, defaulting to ok. Note the outcome union is exercised
 * against the REAL classifier in push/send.test.ts (statuses → gone); here the fixture only
 * selects which branch of dispatch runs, which is dispatch's own claim (cairn:
 * a-fake-cannot-disagree-with-its-author — the classification is not re-asserted from a fake).
 */
class FakePush implements PushTransport {
  sent: { endpoint: string; payload: { title: string; body: string; url: string; tag: string } }[] = [];
  outcomes = new Map<string, PushOutcome>();
  async send(target: PushTarget, payload: { title: string; body: string; url: string; tag: string }) {
    this.sent.push({ endpoint: target.endpoint, payload });
    return this.outcomes.get(target.endpoint) ?? ({ ok: true } as PushOutcome);
  }
}

function setUp(over: Partial<AnswerPost> = {}) {
  const store = new MemoryStore();
  store.posts.set(POST, post(over));
  store.answers = 1;
  store.emails.set(SKIPPER, "sam@example.org");
  const transport = new FakeTransport();
  const push = new FakePush();
  return { store, transport, push };
}

const deps = (s: MemoryStore, t: FakeTransport, p?: FakePush, now: Date = NOW) => ({
  store: s,
  transport: t,
  push: p,
  now,
  siteUrl: SITE,
});

describe("the answer email (AC 1)", () => {
  it("emails the skipper 'N crew answered' with the post link, and logs kind answer", async () => {
    const { store, transport, push } = setUp();
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ count: 1, emailed: true, suppressed: false });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].to).toBe("sam@example.org");
    expect(transport.sent[0].subject).toContain("1 crew answered");
    expect(transport.sent[0].text).toContain(`${SITE}/post/${POST}`);
    const emailLogs = store.logs.filter((l) => l.channel === "email");
    expect(emailLogs).toEqual([
      { kind: KIND_ANSWER, channel: "email", personId: SKIPPER, toEmail: "sam@example.org", postId: POST, providerId: "msg-1", error: null },
    ]);
  });

  it("carries the live count, not a per-event 1", async () => {
    const { store, transport } = setUp();
    store.answers = 3;
    await notifyAnswer(POST, deps(store, transport));
    expect(transport.sent[0].subject).toContain("3 crew answered");
    expect(transport.sent[0].text).toContain("3 crew answered your post");
  });

  it("a refused send is logged with its error and reports emailed: false", async () => {
    const { store, transport } = setUp();
    transport.refuse = true;
    const r = await notifyAnswer(POST, deps(store, transport));
    expect(r).toMatchObject({ emailed: false, suppressed: false });
    const log = store.logs.find((l) => l.kind === KIND_ANSWER);
    expect(log?.error).toBe("provider said no");
    expect(log?.providerId).toBeNull();
  });

  it("a skipper with no contact row is logged, not thrown", async () => {
    const { store, transport } = setUp();
    store.emails.delete(SKIPPER);
    const r = await notifyAnswer(POST, deps(store, transport));
    expect(r).toMatchObject({ emailed: false });
    expect(store.logs.find((l) => l.kind === KIND_ANSWER)?.error).toBe("no contact email");
    expect(transport.sent).toHaveLength(0);
  });

  it("a closed post and a missing post both answer null and send nothing", async () => {
    const { store, transport } = setUp({ closedAt: "2027-06-06T11:00:00Z" });
    expect(await notifyAnswer(POST, deps(store, transport))).toBeNull();
    expect(await notifyAnswer("99999999-9999-4999-8999-999999999999", deps(store, transport))).toBeNull();
    expect(transport.sent).toHaveLength(0);
    expect(store.logs).toHaveLength(0);
  });

  it("zero live answers (the answer was withdrawn under us) sends nothing", async () => {
    const { store, transport, push } = setUp();
    store.answers = 0;
    expect(await notifyAnswer(POST, deps(store, transport, push))).toBeNull();
    expect(transport.sent).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
  });
});

describe("the suppression window (AC 2)", () => {
  it("a second answer inside the window sends no email and writes answer_suppressed", async () => {
    const { store, transport, push } = setUp();
    store.answers = 2;
    store.lastEmail = new Date(NOW.getTime() - 10 * 60 * 1000); // 10 minutes ago
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ emailed: false, suppressed: true });
    expect(transport.sent).toHaveLength(0);
    const emailLogs = store.logs.filter((l) => l.channel === "email");
    expect(emailLogs).toEqual([
      { kind: KIND_ANSWER_SUPPRESSED, channel: "email", personId: SKIPPER, toEmail: null, postId: POST, providerId: null, error: null },
    ]);
  });

  it("an answer at exactly the window's edge is sent — the window is 'within', not 'within or at'", async () => {
    const { store, transport } = setUp();
    store.lastEmail = new Date(NOW.getTime() - ANSWER_EMAIL_WINDOW_MS);
    const r = await notifyAnswer(POST, deps(store, transport));
    expect(r).toMatchObject({ emailed: true, suppressed: false });
    expect(transport.sent).toHaveLength(1);
  });

  it("one millisecond inside the edge suppresses", async () => {
    const { store, transport } = setUp();
    store.lastEmail = new Date(NOW.getTime() - ANSWER_EMAIL_WINDOW_MS + 1);
    const r = await notifyAnswer(POST, deps(store, transport));
    expect(r).toMatchObject({ emailed: false, suppressed: true });
  });

  it("the window measures from the last SUCCESSFUL email: with none recorded, a fresh answer sends", async () => {
    // The store contract does the filtering (error null); here lastEmail null IS that contract's
    // answer for "every earlier attempt failed", and the send must go.
    const { store, transport } = setUp();
    store.lastEmail = null;
    const r = await notifyAnswer(POST, deps(store, transport));
    expect(r).toMatchObject({ emailed: true });
  });
});

describe("the push half (AC 3 — the same call site carries the transports)", () => {
  const target = (id: string) => ({ id, endpoint: `https://push.example/${id}`, p256dh: "k", auth: "a" });

  it("pushes every device the skipper has, logs each, and still emails", async () => {
    const { store, transport, push } = setUp();
    store.targets.set(SKIPPER, [target("d1"), target("d2")]);
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ pushed: 2, pushFailed: 0, pruned: 0, emailed: true });
    expect(push.sent.map((s) => s.endpoint)).toEqual(["https://push.example/d1", "https://push.example/d2"]);
    expect(store.logs.filter((l) => l.kind === KIND_ANSWER_PUSH)).toHaveLength(2);
  });

  it("push is NOT suppressed by the email window — the device tag collapses repeats instead", async () => {
    const { store, transport, push } = setUp();
    store.targets.set(SKIPPER, [target("d1")]);
    store.lastEmail = new Date(NOW.getTime() - 60 * 1000);
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ pushed: 1, suppressed: true, emailed: false });
    expect(push.sent).toHaveLength(1);
  });

  it("a gone subscription is deleted and logged as answer_push_gone; the rest still send", async () => {
    const { store, transport, push } = setUp();
    store.targets.set(SKIPPER, [target("dead"), target("live")]);
    push.outcomes.set("https://push.example/dead", { ok: false, gone: true, error: "410" });
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ pushed: 1, pruned: 1, pushFailed: 0 });
    expect(store.deleted).toEqual(["dead"]);
    expect(store.logs.find((l) => l.kind === KIND_ANSWER_PUSH_GONE)?.providerId).toBe("https://push.example/dead");
  });

  it("an ordinary push failure leaves the row alone and does not stop the email", async () => {
    const { store, transport, push } = setUp();
    store.targets.set(SKIPPER, [target("flaky")]);
    push.outcomes.set("https://push.example/flaky", { ok: false, gone: false, error: "503" });
    const r = await notifyAnswer(POST, deps(store, transport, push));
    expect(r).toMatchObject({ pushed: 0, pushFailed: 1, pruned: 0, emailed: true });
    expect(store.deleted).toEqual([]);
  });

  it("no push transport (no VAPID keys) degrades to email alone", async () => {
    const { store, transport } = setUp();
    store.targets.set(SKIPPER, [target("d1")]);
    const r = await notifyAnswer(POST, deps(store, transport, undefined));
    expect(r).toMatchObject({ pushed: 0, emailed: true });
  });
});

describe("the copy", () => {
  it("answerMessage names the boat, the date and the count, and links the post", () => {
    const m = answerMessage(post(), 2, "sam@example.org", SITE);
    // The when-part comes from whenLabel(), whose exact rendering race-date.test.ts pins; the
    // claim here is the composition — count, boat, when — not the date format.
    expect(m.subject).toBe(`2 crew answered: Blue Moon, ${whenLabel(post().startsAt)}`);
    expect(m.text).toContain("2 crew answered your post for Blue Moon (Thistle), Spring Series 3");
    expect(m.text).toContain(`${SITE}/post/${POST}`);
  });

  it("answerPush carries the count and a tag distinct from the crew-need tag", () => {
    const p = answerPush(post(), 2);
    expect(p.title).toBe("2 crew answered: Blue Moon (Thistle)");
    expect(p.url).toBe(`/post/${POST}`);
    expect(p.tag).toBe(`post-${POST}-answer`);
    expect(p.tag).not.toBe(rungPush(post(), 1).tag);
  });
});
