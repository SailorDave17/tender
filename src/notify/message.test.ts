import { describe, expect, it } from "vitest";
import type { Message, Transport } from "@/email/send";
import { messagePush } from "@/push/payload";
import type { PushOutcome, PushTarget, PushTransport } from "@/push/send";
import {
  KIND_MESSAGE,
  KIND_MESSAGE_NO_ADDRESS,
  KIND_MESSAGE_PUSH,
  KIND_MESSAGE_PUSH_GONE,
  KIND_MESSAGE_SUPPRESSED,
  MESSAGE_EMAIL_WINDOW_MS,
  MESSAGE_SUPPRESS_LIMIT,
  messageEmail,
  notifyMessage,
  type MessageRow,
  type MessageStore,
} from "./message";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * notifyMessage() against an in-memory store and fake transports (story #35 AC 3, AC 4). The
 * clock is injected and every window case moves it explicitly — AC 4 names the fake clock as
 * the instrument, because a ten-minute wait has no place in a test.
 *
 * TWO THINGS THIS FILE DOES DELIBERATELY DIFFERENTLY FROM answer.test.ts, both of them the
 * reason the backstop is testable at all:
 *
 * 1. The store DERIVES `lastMessageEmailAt` and `suppressedSince` from its own log, rather than
 *    returning a value the test set. So the result of one call is the input to the next, and a
 *    multi-step walk can be run. A fake that returns a fixed `lastEmail` can only ever express
 *    single steps, and the defect the backstop exists to prevent is invisible to every single
 *    step (cairn: a-per-step-bound-is-unbounded-across-steps) — every one of them obeys the
 *    rule while the walk does not.
 * 2. The push fake records WHAT it was called with, not merely that it was called. "Email
 *    suppressed, push sent" and "both sent" are the same observation to a fake that drops its
 *    arguments, and one of those two is a defect (cairn:
 *    a-fake-that-drops-an-argument-makes-two-behaviours-one).
 */

const MESSAGE = "11111111-1111-4111-8111-111111111111";
const MATCH = "22222222-2222-4222-8222-222222222222";
const POST = "33333333-3333-4333-8333-333333333333";
const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2027-06-06T12:00:00Z");
const SITE = "https://tender.example.org";

const at = (msAfter: number) => new Date(NOW.getTime() + msAfter);
const MIN = 60 * 1000;

const post = (over: Partial<RungPost> = {}): RungPost => ({
  id: POST,
  raceDateId: "44444444-4444-4444-8444-444444444444",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: "2027-06-06T11:00:00Z", // a matched post is closed
  ...over,
});

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: MESSAGE,
  matchId: MATCH,
  authorId: SKIPPER,
  body: "D dock, 5pm.",
  postId: POST,
  ...over,
});

class MemoryStore implements MessageStore {
  messages = new Map<string, MessageRow>();
  parties_: { skipperId: string; crewId: string } | null = { skipperId: SKIPPER, crewId: CREW };
  posts = new Map<string, RungPost>();
  names = new Map<string, string>();
  emails = new Map<string, string>();
  targets = new Map<string, (PushTarget & { id: string })[]>();
  logs: LogEntry[] = [];
  deleted: string[] = [];
  /** Stamps for log rows, so the derived window has something to measure against. */
  stamps: Date[] = [];
  private clock: Date = NOW;

  /** The dispatcher's `now`, mirrored here so a logged row is stamped at the same instant. */
  tick(now: Date) {
    this.clock = now;
    return now;
  }

  async message(id: string) {
    return this.messages.get(id) ?? null;
  }
  async parties() {
    return this.parties_;
  }
  async post(postId: string) {
    return this.posts.get(postId) ?? null;
  }
  async name(personId: string) {
    return this.names.get(personId) ?? null;
  }
  async email(personId: string) {
    return this.emails.get(personId) ?? null;
  }

  // Derived from the log, not stored: a successful send both moves the anchor and ends the run.
  async lastMessageEmailAt(matchId: string, personId: string) {
    let last: Date | null = null;
    this.logs.forEach((e, i) => {
      if (e.kind === KIND_MESSAGE && e.channel === "email" && e.personId === personId && e.error === null) {
        last = this.stamps[i] ?? null;
      }
    });
    return last;
  }
  // Every attempt, successful or refused — no error filter, and KIND_MESSAGE only so a
  // no-address row never defers a retry that could now succeed.
  async lastMessageAttemptAt(matchId: string, personId: string) {
    let last: Date | null = null;
    this.logs.forEach((e, i) => {
      if (e.kind === KIND_MESSAGE && e.channel === "email" && e.personId === personId) {
        last = this.stamps[i] ?? null;
      }
    });
    return last;
  }
  async suppressedSince(matchId: string, personId: string, since: Date | null) {
    let n = 0;
    this.logs.forEach((e, i) => {
      const when = this.stamps[i];
      if (since && when && when.getTime() < since.getTime()) return;
      if (e.kind === KIND_MESSAGE_SUPPRESSED && e.personId === personId && e.error === null) n += 1;
    });
    return n;
  }

  async pushTargets(personId: string) {
    return this.targets.get(personId) ?? [];
  }
  async deleteSubscription(id: string) {
    this.deleted.push(id);
  }
  async emailsSentToday() {
    return this.sentToday;
  }
  sentToday = 0;
  async log(entry: LogEntry) {
    this.logs.push(entry);
    this.stamps.push(this.clock);
  }
}

/** Records the full argument bag, so two behaviours that differ only in it stay distinguishable. */
function recordingTransport(fail?: string): Transport & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(m: Message) {
      sent.push(m);
      if (fail) throw new Error(fail);
      return { id: `re_${sent.length}` };
    },
  };
}

function recordingPush(outcome: (t: PushTarget) => PushOutcome = () => ({ ok: true })): PushTransport & {
  calls: { target: PushTarget; payload: unknown }[];
} {
  const calls: { target: PushTarget; payload: unknown }[] = [];
  return {
    calls,
    async send(target: PushTarget, payload: unknown) {
      calls.push({ target, payload });
      return outcome(target);
    },
  } as PushTransport & { calls: { target: PushTarget; payload: unknown }[] };
}

function store(over: (s: MemoryStore) => void = () => {}): MemoryStore {
  const s = new MemoryStore();
  s.messages.set(MESSAGE, row());
  s.posts.set(POST, post());
  s.names.set(SKIPPER, "Sam");
  s.names.set(CREW, "Cy");
  s.emails.set(SKIPPER, "sam@hsc-crew.org");
  s.emails.set(CREW, "cy@hsc-crew.org");
  over(s);
  return s;
}

describe("notifyMessage — who is notified", () => {
  it("emails the counterparty, never the author", async () => {
    const s = store();
    const transport = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });

    expect(r?.emailed).toBe(true);
    // The author wrote it; the crew is who hears about it.
    expect(transport.sent.map((m) => m.to)).toEqual(["cy@hsc-crew.org"]);
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE)).toEqual([
      { kind: KIND_MESSAGE, channel: "email", personId: CREW, toEmail: "cy@hsc-crew.org", postId: POST, providerId: "re_1", error: null },
    ]);
  });

  it("notifies the skipper when the crew is the author — the direction comes from the match", async () => {
    const s = store((x) => x.messages.set(MESSAGE, row({ authorId: CREW })));
    const transport = recordingTransport();
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(transport.sent.map((m) => m.to)).toEqual(["sam@hsc-crew.org"]);
  });

  it("notifies nobody when the author is neither party", async () => {
    const s = store((x) => x.messages.set(MESSAGE, row({ authorId: STRANGER })));
    const transport = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(r).toBeNull();
    expect(transport.sent).toEqual([]);
    expect(s.logs).toEqual([]);
  });
});

describe("notifyMessage — push is never suppressed (AC 3)", () => {
  it("pushes on every message while the email is suppressed, and the payloads differ per message", async () => {
    const s = store((x) => x.targets.set(CREW, [{ id: "sub1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }]));
    const transport = recordingTransport();
    const push = recordingPush();

    await notifyMessage(MESSAGE, { store: s, transport, push, now: NOW, siteUrl: SITE });
    s.tick(at(MIN));
    s.messages.set(MESSAGE, row({ body: "Bring gloves." }));
    const second = await notifyMessage(MESSAGE, { store: s, transport, push, now: at(MIN), siteUrl: SITE });

    // Email: one sent, one suppressed.
    expect(transport.sent).toHaveLength(1);
    expect(second?.suppressed).toBe(true);
    // Push: BOTH, and the second carries the second body — a fake that recorded only the count
    // could not tell this apart from the email having gone out too.
    expect(push.calls).toHaveLength(2);
    expect(push.calls.map((c) => (c.payload as { body: string }).body)).toEqual(["D dock, 5pm.", "Bring gloves."]);
    expect(push.calls.every((c) => (c.payload as { body?: string }).body !== undefined)).toBe(true);
    // And the tag is the thread's, so a burst collapses on the device.
    expect(new Set(push.calls.map((c) => (c.payload as { tag: string }).tag)).size).toBe(1);
    // Both pushes are logged as attempts against the recipient, which is what makes a push
    // that silently did not happen distinguishable from one that did (#43 reads these rows).
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE_PUSH && e.error === null)).toHaveLength(2);
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE_PUSH).every((e) => e.personId === CREW)).toBe(true);
  });

  it("prunes a subscription the push service retired, and logs its epitaph", async () => {
    const s = store((x) => x.targets.set(CREW, [{ id: "sub1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }]));
    const push = recordingPush(() => ({ ok: false, gone: true, error: "410 Gone" }));
    const r = await notifyMessage(MESSAGE, { store: s, transport: recordingTransport(), push, now: NOW, siteUrl: SITE });
    expect(r?.pruned).toBe(1);
    expect(s.deleted).toEqual(["sub1"]);
    expect(s.logs.some((e) => e.kind === KIND_MESSAGE_PUSH_GONE)).toBe(true);
  });

  it("emails even with no push transport configured", async () => {
    const s = store();
    const transport = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(r?.emailed).toBe(true);
    expect(r?.pushed).toBe(0);
  });
});

describe("notifyMessage — the ten-minute window (AC 4)", () => {
  // The straddle: just inside and just past, both derived from the constant. These two prove the
  // BOUNDARY BEHAVIOUR and deliberately say nothing about the constant's value — they pass at any
  // W, which is correct for what they are for and is why the pinning test below exists.
  //
  // That separation was not here until a review found the gap. The original comment claimed "the
  // band test below is what holds the constant's value", and a band constrains a RANGE, never a
  // value: *measured*, mutating 10 → 20 minutes reddened 0 of 21 tests. A test may derive its
  // observation window from the code under test, or test that window's value, but not both
  // (cairn: prove-a-guard-test-can-fail, fifteenth outcome) — and writing the mitigation prose
  // in the same breath as the gap is what stopped anyone looking. `thread-view.test.ts` had the
  // right pattern eleven lines away the whole time.
  it("suppresses a second message just inside the window", async () => {
    const s = store();
    const transport = recordingTransport();
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    const justInside = at(MESSAGE_EMAIL_WINDOW_MS - 1000);
    s.tick(justInside);
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: justInside, siteUrl: SITE });

    expect(r?.suppressed).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE_SUPPRESSED)).toEqual([
      { kind: KIND_MESSAGE_SUPPRESSED, channel: "email", personId: CREW, toEmail: null, postId: POST, providerId: null, error: null },
    ]);
  });

  it("emails a second message just past the window", async () => {
    const s = store();
    const transport = recordingTransport();
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    const justPast = at(MESSAGE_EMAIL_WINDOW_MS + 1000);
    s.tick(justPast);
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: justPast, siteUrl: SITE });

    expect(r?.suppressed).toBe(false);
    expect(r?.emailed).toBe(true);
    expect(transport.sent).toHaveLength(2);
  });

  /**
   * THE FAILING-PROVIDER WALK. The single-step rule is that a refusal does not start a quiet
   * window (the test below), and that rule walked five steps used to mean every message in a
   * burst made a fresh outbound API call: no successful send ever existed, so the anchor stayed
   * null for ever and the ten-minute window that protects the 100/day cap was bypassed entirely.
   * Only EMAIL_SKIP_AT remained — 95 real calls a day. Found by review; the single-step test
   * below passed throughout, which is the same step-versus-walk shape as the backstop.
   */
  it("rations retries while the provider keeps refusing: one per window, not one per message", async () => {
    const s = store();
    const transport = recordingTransport("provider refused");
    const outcomes: string[] = [];
    // Five messages, one minute apart, provider refusing every time.
    for (let step = 0; step < 5; step += 1) {
      const when = at(step * MIN);
      s.tick(when);
      const r = await notifyMessage(MESSAGE, { store: s, transport, now: when, siteUrl: SITE });
      outcomes.push(r?.retryDeferred ? "deferred" : "attempted");
    }
    // The first tries; the next four are held off the provider.
    expect(outcomes).toEqual(["attempted", "deferred", "deferred", "deferred", "deferred"]);
    expect(transport.sent).toHaveLength(1);

    // Past the window, one more retry is allowed — a deferral is not a permanent stop.
    const later = at(11 * MIN);
    s.tick(later);
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: later, siteUrl: SITE });
    expect(r?.retryDeferred).toBe(false);
    expect(transport.sent).toHaveLength(2);
  });

  it("a deferred retry is logged distinguishably from an ordinary suppression", async () => {
    // Different facts: an ordinary suppression means the counterparty WAS reached recently; a
    // deferral means they were not reached at all. #43's operator view reads these rows.
    const s = store();
    const transport = recordingTransport("provider refused");
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    s.tick(at(MIN));
    await notifyMessage(MESSAGE, { store: s, transport, now: at(MIN), siteUrl: SITE });
    const suppressions = s.logs.filter((e) => e.kind === KIND_MESSAGE_SUPPRESSED);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]?.error).toBe("retry deferred");
  });

  it("a refused send does not start a quiet window — the next message retries", async () => {
    const s = store();
    const transport = recordingTransport("provider refused");
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE && e.error !== null)).toHaveLength(1);

    // Past the retry floor, the next message reaches the provider and succeeds. This is AC 4's
    // "a refused send does not start a quiet window" — the window belongs to SUCCESSFUL sends,
    // so a refusal never suppresses and the message is retried rather than dropped.
    //
    // THE ASSERTION MOVED FROM ONE MINUTE TO ELEVEN, and that is a real narrowing rather than a
    // convenience. This test used to retry at one minute and pass, which is the same fact the
    // failing-provider walk above turns into a defect: with no successful send there was no
    // anchor at all, so EVERY message made a fresh outbound call for as long as the provider
    // stayed down. The retry floor is what bounds that, and it defers rather than suppresses —
    // `retryDeferred`, not `suppressed`, because the counterparty was never reached.
    const later = at(11 * MIN);
    s.tick(later);
    const ok = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport: ok, now: later, siteUrl: SITE });
    expect(r?.suppressed).toBe(false);
    expect(r?.retryDeferred).toBe(false);
    expect(r?.emailed).toBe(true);
    // And the retry is a real send, not a suppression dressed as one.
    expect(ok.sent).toHaveLength(1);
  });

  it("holds the window in a band whose edges are product statements, not the constant", async () => {
    // The band is a SANITY RAIL, not the pin — it catches an absurd value and nothing else.
    // Below ~2 minutes the suppression is decoration; above ~30 a genuine second message goes
    // unnoticed for half an hour, which is what the thread exists to prevent.
    expect(MESSAGE_EMAIL_WINDOW_MS).toBeGreaterThanOrEqual(2 * MIN);
    expect(MESSAGE_EMAIL_WINDOW_MS).toBeLessThanOrEqual(30 * MIN);
  });

  // THE PIN. Hardcoded gaps, no arithmetic on the constant: a nine-minute gap must suppress and
  // an eleven-minute gap must email, which is true at ten minutes and at no other value the band
  // admits. Moving the constant in either direction reddens one of these two, which is exactly
  // what the straddle tests above cannot do.
  it("suppresses at a nine-minute gap and emails at eleven — pinning ten minutes, not a band", async () => {
    const nine = store();
    const t1 = recordingTransport();
    await notifyMessage(MESSAGE, { store: nine, transport: t1, now: NOW, siteUrl: SITE });
    nine.tick(at(9 * MIN));
    const inside = await notifyMessage(MESSAGE, { store: nine, transport: t1, now: at(9 * MIN), siteUrl: SITE });
    expect(inside?.suppressed).toBe(true);
    expect(t1.sent).toHaveLength(1);

    const eleven = store();
    const t2 = recordingTransport();
    await notifyMessage(MESSAGE, { store: eleven, transport: t2, now: NOW, siteUrl: SITE });
    eleven.tick(at(11 * MIN));
    const outside = await notifyMessage(MESSAGE, { store: eleven, transport: t2, now: at(11 * MIN), siteUrl: SITE });
    expect(outside?.suppressed).toBe(false);
    expect(outside?.emailed).toBe(true);
    expect(t2.sent).toHaveLength(2);
  });
});

describe("notifyMessage — the backstop (AC 4)", () => {
  /**
   * THE MULTI-STEP WALK. Every step below is inside the window and so obeys the single-step
   * rule; the claim is about the walk, and no straddle test above can see it.
   *
   * THE GAP HAS TO BE SHORTER THAN THE WINDOW, and getting this wrong is the whole lesson of
   * this test. The anchor is the last email SENT, not the last message — so at a gap of 9
   * minutes against a 10-minute window, only the message at 9 minutes is suppressed; the one at
   * 18 is measured against the anchor still sitting at 0, is outside the window, and emails on
   * its own. The run never reaches the limit and the backstop never fires. A first draft of this
   * test used a 9-minute drip and read `emailed` where it predicted `forced` — the fixture was
   * wrong, not the code (cairn: a-per-step-bound-is-unbounded-across-steps, whose own worked
   * example moves its reference the same way).
   *
   * So the case the backstop actually closes is a BURST: messages arriving faster than the
   * window, which is exactly what "which dock, what time" looks like when somebody is typing.
   * One minute apart, ten of them.
   */
  it("forces an email after three consecutive suppressions, then resets the run", async () => {
    const s = store();
    const transport = recordingTransport();
    const outcomes: string[] = [];

    for (let step = 0; step < 10; step += 1) {
      const when = at(step * MIN);
      s.tick(when);
      s.messages.set(MESSAGE, row({ body: `message ${step}` }));
      const r = await notifyMessage(MESSAGE, { store: s, transport, now: when, siteUrl: SITE });
      outcomes.push(r?.emailed ? (r.forced ? "forced" : "emailed") : "suppressed");
    }

    // Step 0 emails (no anchor). Steps 1-3 are suppressed. Step 4 is the fourth message inside
    // the window with three suppressions behind it, so it is forced — and resets both the run
    // and the anchor, so 5-7 suppress and 8 forces again.
    expect(outcomes).toEqual([
      "emailed",
      "suppressed",
      "suppressed",
      "suppressed",
      "forced",
      "suppressed",
      "suppressed",
      "suppressed",
      "forced",
      "suppressed",
    ]);
    // Three emails out of ten messages, rather than one out of ten.
    expect(transport.sent).toHaveLength(3);
  });

  it("without the backstop a burst would email once — the run is what prevents it", async () => {
    // Read as the counterparty experiences it: they hear on step 0 and, with no backstop, would
    // hear nothing again however long the burst ran. This test states the defect the backstop
    // closes, so a change that removes it has to delete a stated claim rather than a constant.
    const s = store();
    const transport = recordingTransport();
    for (let step = 0; step < 6; step += 1) {
      const when = at(step * MIN);
      s.tick(when);
      await notifyMessage(MESSAGE, { store: s, transport, now: when, siteUrl: SITE });
    }
    expect(transport.sent.length).toBeGreaterThan(1);
  });

  it("names how many were missed in the forced email, so it does not understate what is waiting", async () => {
    const s = store();
    const transport = recordingTransport();
    for (let step = 0; step < 5; step += 1) {
      const when = at(step * MIN);
      s.tick(when);
      await notifyMessage(MESSAGE, { store: s, transport, now: when, siteUrl: SITE });
    }
    const forced = transport.sent[transport.sent.length - 1];
    expect(forced.text).toContain("3 more messages");
  });

  it("holds the limit in a band: high enough to ration, low enough to stay a backstop", async () => {
    expect(MESSAGE_SUPPRESS_LIMIT).toBeGreaterThanOrEqual(2);
    expect(MESSAGE_SUPPRESS_LIMIT).toBeLessThanOrEqual(5);
  });
});

describe("notifyMessage — the cap and the missing pieces", () => {
  it("skips the send at the daily cap and logs why, without claiming it was forced", async () => {
    const s = store((x) => {
      x.sentToday = EMAIL_SKIP_AT;
    });
    const transport = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(r?.skippedCap).toBe(true);
    expect(r?.forced).toBe(false);
    expect(transport.sent).toEqual([]);
    expect(s.logs.filter((e) => e.error === "daily cap")).toHaveLength(1);
  });

  it("logs a counterparty with no contact row under its own kind, not against the cap", async () => {
    const s = store((x) => x.emails.delete(CREW));
    const transport = recordingTransport();
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    expect(r?.emailed).toBe(false);
    expect(s.logs.filter((e) => e.error === "no contact email")).toHaveLength(1);
    // The KIND is what keeps it off the cap, because emailsSentToday() counts kinds and not
    // errors — a `message` row here would spend a slot of the app-wide daily budget on an email
    // that never reached the provider. #23 set this precedent with rung_email_no_address.
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE_NO_ADDRESS)).toHaveLength(1);
    expect(s.logs.filter((e) => e.kind === KIND_MESSAGE)).toHaveLength(0);
  });

  it("does not let a no-address row defer a later retry that could succeed", async () => {
    // The retry floor reads attempts on the PROVIDER. A missing contact row is not one, so
    // adding the address must let the very next message email rather than wait out a window.
    const s = store((x) => x.emails.delete(CREW));
    const transport = recordingTransport();
    await notifyMessage(MESSAGE, { store: s, transport, now: NOW, siteUrl: SITE });
    s.emails.set(CREW, "cy@hsc-crew.org");
    s.tick(at(MIN));
    const r = await notifyMessage(MESSAGE, { store: s, transport, now: at(MIN), siteUrl: SITE });
    expect(r?.emailed).toBe(true);
    expect(r?.retryDeferred).toBe(false);
  });

  it("returns null when the message, the match or the post is gone", async () => {
    const gone = store((x) => x.messages.clear());
    expect(await notifyMessage(MESSAGE, { store: gone, transport: recordingTransport(), now: NOW, siteUrl: SITE })).toBeNull();

    const noMatch = store((x) => {
      x.parties_ = null;
    });
    expect(await notifyMessage(MESSAGE, { store: noMatch, transport: recordingTransport(), now: NOW, siteUrl: SITE })).toBeNull();

    const noPost = store((x) => x.posts.clear());
    expect(await notifyMessage(MESSAGE, { store: noPost, transport: recordingTransport(), now: NOW, siteUrl: SITE })).toBeNull();
  });
});

describe("messageEmail — the copy", () => {
  it("names the author, the boat and the thread link, and says nothing of the body", async () => {
    const m = messageEmail(post(), "Sam", "cy@hsc-crew.org", SITE, 0);
    expect(m.to).toBe("cy@hsc-crew.org");
    expect(m.subject).toContain("Sam messaged you");
    expect(m.subject).toContain("Blue Moon");
    expect(m.text).toContain(`${SITE}/post/${POST}/thread`);
    // The body is deliberately absent from the email: the thread is the record, and an email is
    // a copy of a private conversation sitting in an inbox for ever.
    expect(m.text).not.toContain("D dock");
    expect(m.text).not.toContain("and 0 more");
  });

  it("pluralises the missed count", async () => {
    expect(messageEmail(post(), "Sam", "x@y.z", SITE, 1).text).toContain("and 1 more message");
    expect(messageEmail(post(), "Sam", "x@y.z", SITE, 3).text).toContain("and 3 more messages");
  });
});

describe("messagePush — the preview", () => {
  it("truncates a long body so the 4 KB ceiling is never approached", async () => {
    const long = "x".repeat(2000);
    const p = messagePush(post(), "Sam", long, MATCH);
    expect(p.body.length).toBeLessThan(200);
    expect(p.body.endsWith("…")).toBe(true);
    expect(p.title).toContain("Sam");
    expect(p.url).toBe(`/post/${POST}/thread`);
  });

  it("leaves a short body alone", async () => {
    expect(messagePush(post(), "Sam", "D dock, 5pm.", MATCH).body).toBe("D dock, 5pm.");
  });
});
