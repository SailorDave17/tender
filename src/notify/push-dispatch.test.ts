import { describe, expect, it } from "vitest";
import type { Crew, Rung } from "@/engine/ladder";
import type { Message, Transport } from "@/email/send";
import type { PushOutcome, PushTarget, PushTransport } from "@/push/send";
import type { PushPayload } from "@/push/payload";
import {
  KIND_RUNG_EMAIL,
  KIND_RUNG_PUSH,
  KIND_RUNG_PUSH_GONE,
  notifyRung,
  type LogEntry,
  type PendingPush,
  type RungPost,
  type RungStore,
} from "./rung";

/**
 * Both channels through one dispatch (story #29 AC 2, 3, 4).
 *
 * The store is in memory here and the SQL half is `test/push-subscription.test.ts`; what this
 * file owns is the composition — who gets which channel, what the log records, and what a second
 * run does. Those are decisions in `dispatchPending`, and a database cannot disagree with them.
 */

const RACE = new Date("2027-06-13T17:00:00Z");
const NOW = new Date("2027-06-06T12:00:00Z"); // a week out: the clock opens nothing
const POST = "11111111-1111-4111-8111-111111111111";
const DATE = "22222222-2222-4222-8222-222222222222";

const crew = (id: string, rating: 1 | 2 | 3 | 4, hulls: string[] = []): Crew => ({ id, rating, hulls, available: true });
const email = (id: string) => `${id}@example.org`;
const target = (id: string, n = 1): PushTarget & { id: string } => ({
  id: `${id}-device-${n}`,
  endpoint: `https://push.example/${id}/${n}`,
  p256dh: "BNc...",
  auth: "k3y",
});

type Row = { postId: string; personId: string; rung: Rung; notifiedAt: Date | null; pushedAt: Date | null };

class Store implements RungStore {
  posts = new Map<string, RungPost>();
  pools = new Map<string, Crew[]>();
  emails = new Map<string, string>();
  subs = new Map<string, (PushTarget & { id: string })[]>();
  suggestions: Row[] = [];
  logs: LogEntry[] = [];

  async post(id: string) {
    return this.posts.get(id) ?? null;
  }
  async pool(dateId: string) {
    return this.pools.get(dateId) ?? [];
  }
  async raiseRung(id: string, rung: Rung) {
    this.posts.set(id, { ...this.posts.get(id)!, currentRung: rung });
  }
  async addSuggestions(rows: { postId: string; personId: string; rung: Rung }[]) {
    for (const r of rows) {
      if (this.suggestions.some((s) => s.postId === r.postId && s.personId === r.personId)) continue;
      this.suggestions.push({ ...r, notifiedAt: null, pushedAt: null });
    }
  }
  async pending(postId: string) {
    return this.suggestions
      .filter((s) => s.postId === postId && s.notifiedAt === null)
      .map((s) => ({ personId: s.personId, rung: s.rung, email: this.emails.get(s.personId) ?? null }));
  }
  async emailsSentToday() {
    return this.logs.filter((l) => l.kind === KIND_RUNG_EMAIL).length;
  }
  async log(entry: LogEntry) {
    this.logs.push(entry);
  }
  async markNotified(postId: string, personId: string, at: Date) {
    this.suggestions.find((s) => s.postId === postId && s.personId === personId)!.notifiedAt = at;
  }
  async pendingPush(postId: string): Promise<PendingPush[]> {
    return this.suggestions
      .filter((s) => s.postId === postId && s.pushedAt === null)
      .map((s) => ({ personId: s.personId, rung: s.rung, targets: this.subs.get(s.personId) ?? [] }))
      .filter((p) => p.targets.length > 0);
  }
  async markPushed(postId: string, personId: string, at: Date) {
    this.suggestions.find((s) => s.postId === postId && s.personId === personId)!.pushedAt = at;
  }
  async deleteSubscription(id: string) {
    for (const [person, list] of this.subs) {
      const kept = list.filter((t) => t.id !== id);
      if (kept.length) this.subs.set(person, kept);
      else this.subs.delete(person);
    }
  }
}

class FakeEmail implements Transport {
  sent: Message[] = [];
  async send(m: Message) {
    this.sent.push(m);
    return { id: `msg-${this.sent.length}` };
  }
}

class FakePush implements PushTransport {
  sent: { endpoint: string; payload: PushPayload }[] = [];
  /** endpoint → the outcome to answer with. Anything absent succeeds. */
  outcomes = new Map<string, PushOutcome>();
  async send(t: PushTarget, payload: PushPayload) {
    const outcome = this.outcomes.get(t.endpoint) ?? { ok: true as const };
    if (outcome.ok) this.sent.push({ endpoint: t.endpoint, payload });
    return outcome;
  }
}

/**
 * notifyRung() returns null for a post that is missing or closed. Every case here uses a live
 * post, so a null is a fixture fault rather than a result — asserted rather than silenced with a
 * non-null assertion, so the day it happens the message says which.
 */
async function notify(deps: Parameters<typeof notifyRung>[1]) {
  const r = await notifyRung(POST, deps);
  expect(r, "the post is open, so notifyRung must not return null").not.toBeNull();
  return r!;
}

/** Three crew on rung 1 for a Thistle at minimum 2; `installed` are the ones with a device. */
function setUp(installed: string[]) {
  const store = new Store();
  store.posts.set(POST, {
    id: POST,
    raceDateId: DATE,
    boatClass: "Thistle",
    boatName: "Blue Moon",
    minimum: 2,
    startsAt: RACE.toISOString(),
    dateTitle: "Spring Series 3",
    currentRung: 1,
    closedAt: null,
  });
  const pool = [crew("ana", 2, ["Thistle"]), crew("bo", 3, ["Thistle"]), crew("cy", 3)];
  store.pools.set(DATE, pool);
  for (const c of pool) store.emails.set(c.id, email(c.id));
  for (const id of installed) store.subs.set(id, [target(id)]);
  const transport = new FakeEmail();
  const push = new FakePush();
  return { store, transport, push, deps: { store, transport, push, now: NOW, siteUrl: "https://tender.test" } };
}

describe("AC 2 — both channels, and no install gets email only", () => {
  it("3 crew of whom 2 have subscriptions: 2 pushes, 3 emails, 5 log rows carrying their channel", async () => {
    const { store, transport, push, deps } = setUp(["ana", "bo"]);
    const r = await notify(deps);

    expect(r).toEqual({ rung: 1, suggested: 3, sent: 3, skippedCap: 0, failed: 0, pushed: 2, pushFailed: 0, pruned: 0 });
    expect(push.sent.map((p) => p.endpoint).sort()).toEqual(["https://push.example/ana/1", "https://push.example/bo/1"]);
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["ana", "bo", "cy"].map(email));

    expect(store.logs).toHaveLength(5);
    expect(store.logs.filter((l) => l.channel === "push")).toHaveLength(2);
    expect(store.logs.filter((l) => l.channel === "email")).toHaveLength(3);
    // An installed crew gets BOTH — the push is additional, never a substitute.
    for (const id of ["ana", "bo"]) {
      expect(store.logs.filter((l) => l.personId === id).map((l) => l.channel).sort()).toEqual(["email", "push"]);
    }
    expect(store.logs.filter((l) => l.personId === "cy").map((l) => l.channel)).toEqual(["email"]);
  });

  it("pushes what the crew's own rung says, to every device that person has", async () => {
    const { store, push, deps } = setUp([]);
    store.subs.set("ana", [target("ana", 1), target("ana", 2)]);
    const r = await notify(deps);

    expect(r.pushed).toBe(2); // two devices, one person
    expect(push.sent.map((p) => p.endpoint).sort()).toEqual(["https://push.example/ana/1", "https://push.example/ana/2"]);
    expect(push.sent[0].payload.title).toBe("Crew needed: Blue Moon (Thistle)");
    expect(push.sent[0].payload.url).toBe(`/post/${POST}`);
  });

  it("sends no push at all when the deployment has no VAPID keys, and still emails everyone", async () => {
    // ADR 007's fallback: push best-effort, email always. `push` is undefined on a project whose
    // keys were never set, and the email half must be untouched by that.
    const { store, transport, deps } = setUp(["ana", "bo"]);
    const r = await notify({ ...deps, push: undefined });
    expect(r.pushed).toBe(0);
    expect(transport.sent).toHaveLength(3);
    expect(store.logs.filter((l) => l.channel === "push")).toHaveLength(0);
    expect(store.suggestions.every((s) => s.pushedAt === null)).toBe(true);
  });
});

describe("AC 3 — a dead subscription is deleted and the email still goes", () => {
  for (const status of [404, 410] as const) {
    it(`${status}: the row is deleted, the person stays unpushed, and their email is unaffected`, async () => {
      const { store, transport, push, deps } = setUp(["ana", "bo"]);
      push.outcomes.set("https://push.example/ana/1", { ok: false, gone: true, error: `${status} gone` });

      const r = await notify(deps);

      expect(r.pruned).toBe(1);
      expect(r.pushed).toBe(1); // bo's still went
      expect(store.subs.has("ana")).toBe(false); // deleted
      expect(store.logs.filter((l) => l.kind === KIND_RUNG_PUSH_GONE)).toHaveLength(1);
      // The email is the backstop and is completely unaffected by the push failing.
      expect(transport.sent.map((m) => m.to).sort()).toEqual(["ana", "bo", "cy"].map(email));
      expect(store.suggestions.find((s) => s.personId === "ana")!.notifiedAt).toEqual(NOW);
    });
  }

  it("an ordinary push failure keeps the subscription and leaves the person pending a push", async () => {
    // Not `gone`: a 500 from the push service, or a network blip. Deleting the row on that would
    // silently uninstall a crew who did nothing wrong.
    const { store, push, deps } = setUp(["ana"]);
    push.outcomes.set("https://push.example/ana/1", { ok: false, gone: false, error: "503 unavailable" });

    const r = await notify(deps);
    expect(r.pushFailed).toBe(1);
    expect(r.pruned).toBe(0);
    expect(store.subs.get("ana")).toHaveLength(1); // kept
    expect(store.suggestions.find((s) => s.personId === "ana")!.pushedAt).toBeNull();
    expect(store.logs.filter((l) => l.kind === KIND_RUNG_PUSH && l.error === "503 unavailable")).toHaveLength(1);
  });

  it("a person whose every device is dead is not marked pushed, so a re-install is told", async () => {
    const { store, push, deps } = setUp([]);
    store.subs.set("ana", [target("ana", 1), target("ana", 2)]);
    push.outcomes.set("https://push.example/ana/1", { ok: false, gone: true, error: "410" });
    push.outcomes.set("https://push.example/ana/2", { ok: false, gone: true, error: "410" });

    const r = await notify(deps);
    expect(r.pruned).toBe(2);
    expect(store.subs.has("ana")).toBe(false);
    expect(store.suggestions.find((s) => s.personId === "ana")!.pushedAt).toBeNull();
  });
});

describe("AC 4 — a second run pushes nobody", () => {
  it("running twice sends each channel exactly once", async () => {
    const { store, transport, push, deps } = setUp(["ana", "bo"]);
    await notify(deps);
    const second = await notify(deps);

    expect(second).toEqual({ rung: 1, suggested: 3, sent: 0, skippedCap: 0, failed: 0, pushed: 0, pushFailed: 0, pruned: 0 });
    expect(push.sent).toHaveLength(2);
    expect(transport.sent).toHaveLength(3);
    expect(store.logs).toHaveLength(5);
  });

  it("the two ledgers are independent: an email retried tomorrow does not re-push", async () => {
    // The case the second column exists for. `ana`'s email fails, so `notified_at` stays NULL and
    // the next run retries it — and if push shared that column, her phone would buzz again for a
    // post she was already told about, because of a mail server.
    const { store, transport, push, deps } = setUp(["ana"]);
    const failing = new (class extends FakeEmail {
      async send(m: Message) {
        if (m.to === email("ana")) throw new Error("provider said no");
        return super.send(m);
      }
    })();

    const first = await notify({ ...deps, transport: failing });
    expect(first.pushed).toBe(1);
    expect(first.failed).toBe(1);
    expect(store.suggestions.find((s) => s.personId === "ana")!.pushedAt).toEqual(NOW); // pushed
    expect(store.suggestions.find((s) => s.personId === "ana")!.notifiedAt).toBeNull(); // not emailed

    const second = await notify({ ...deps, transport });
    expect(second.sent).toBe(1); // the email retried
    expect(second.pushed).toBe(0); // and the phone was NOT buzzed a second time
    expect(push.sent).toHaveLength(1);
  });
});
