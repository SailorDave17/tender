import { describe, expect, it } from "vitest";
import { whenLabel } from "@/dates/race-date";
import type { Message, Transport } from "@/email/send";
import type { RaceIcsInputs } from "@/calendar/read";
import { ICS_CONTENT_TYPE } from "@/calendar/race-ics";
import { EMAIL_ATTEMPT_KINDS } from "./kinds";
import {
  KIND_MATCH,
  KIND_MATCH_ICS_FAILED,
  KIND_MATCH_SKIPPED_CAP,
  matchMessage,
  notifyMatch,
  type MatchParties,
  type MatchStore,
} from "./match";
import { EMAIL_SKIP_AT, type LogEntry, type RungPost } from "./rung";

/**
 * notifyMatch() against an in-memory store and a fake transport (story #33, all three ACs).
 * The cap count is injected per case, because AC 3's "at the cap" is a fact about the day's
 * ledger, not about anything this module writes.
 */

const POST = "11111111-1111-4111-8111-111111111111";
const MATCH = "33333333-3333-4333-8333-333333333333";
const SKIPPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2027-06-06T12:00:00Z");
const SITE = "https://tender.example.org";

// closedAt set on purpose: accept_answer() closes the post in the same transaction that writes
// the match, so a closed post is this notifier's NORMAL input — a closed-post guard copied from
// notifyRung() would make every match email silently not happen.
const post = (over: Partial<RungPost> = {}): RungPost => ({
  id: POST,
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: "2027-06-06T11:59:00Z",
  ...over,
});

class MemoryStore implements MatchStore {
  posts = new Map<string, RungPost>();
  matches = new Map<string, MatchParties>();
  names = new Map<string, string>();
  emails = new Map<string, string>();
  sentToday = 0;
  logs: LogEntry[] = [];

  async post(postId: string) {
    return this.posts.get(postId) ?? null;
  }
  async matchByPost(postId: string) {
    return this.matches.get(postId) ?? null;
  }
  async name(personId: string) {
    return this.names.get(personId) ?? null;
  }
  async email(personId: string) {
    return this.emails.get(personId) ?? null;
  }
  async emailsSentToday() {
    return this.sentToday;
  }
  // #34: what the crew's .ics is built from. `calendarError` makes the read throw, the way a
  // failed service-role query would; `calendarCalls` counts the reads.
  calendarInputs = new Map<string, RaceIcsInputs>();
  calendarError: string | null = null;
  calendarCalls: string[] = [];
  async calendar(matchId: string) {
    this.calendarCalls.push(matchId);
    if (this.calendarError) throw new Error(this.calendarError);
    return this.calendarInputs.get(matchId) ?? null;
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
    return { id: `sent-${this.sent.length}` };
  }
}

function matchedStore(): MemoryStore {
  const store = new MemoryStore();
  store.posts.set(POST, post());
  store.matches.set(POST, { id: MATCH, skipperId: SKIPPER, crewId: CREW });
  store.names.set(SKIPPER, "Sam Skipper");
  store.names.set(CREW, "Robin Crew");
  store.emails.set(SKIPPER, "sam@example.org");
  store.emails.set(CREW, "robin@example.org");
  store.calendarInputs.set(MATCH, {
    matchId: MATCH,
    postId: POST,
    skipperId: SKIPPER,
    crewId: CREW,
    acceptedAt: "2027-06-06T11:59:00Z",
    skipperName: "Sam Skipper",
    boatClass: "Thistle",
    note: "Bring gloves",
    startsAt: "2027-06-13T17:00:00Z",
    clubName: "Hoover Sailing Club",
  });
  return store;
}

const deps = (store: MatchStore, transport: Transport) => ({ store, transport, now: NOW, siteUrl: SITE });

describe("notifyMatch — two emails, each naming the other party (AC 1)", () => {
  it("sends exactly two, one per party, and logs each as kind match with the provider id", async () => {
    const store = matchedStore();
    const transport = new FakeTransport();
    const result = await notifyMatch(POST, deps(store, transport));

    expect(result).toEqual({ sent: 2, skippedCap: 0, failed: 0 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(["robin@example.org", "sam@example.org"]);

    const logs = store.logs.filter((l) => l.kind === KIND_MATCH);
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.channel).toBe("email");
      expect(l.postId).toBe(POST);
      expect(l.providerId).toMatch(/^sent-/);
      expect(l.error).toBeNull();
    }
    expect(logs.map((l) => l.personId).sort()).toEqual([SKIPPER, CREW].sort());
  });

  it("each email names the OTHER person, the class, the race date and time, and the post URL", async () => {
    const store = matchedStore();
    const transport = new FakeTransport();
    await notifyMatch(POST, deps(store, transport));

    const toSkipper = transport.sent.find((m) => m.to === "sam@example.org")!;
    const toCrew = transport.sent.find((m) => m.to === "robin@example.org")!;
    const when = whenLabel("2027-06-13T17:00:00Z");

    expect(toSkipper.text).toContain("Robin Crew");
    expect(toSkipper.text).not.toContain("Sam Skipper");
    expect(toCrew.text).toContain("Sam Skipper");
    expect(toCrew.text).not.toContain("Robin Crew");
    for (const m of [toSkipper, toCrew]) {
      expect(m.text).toContain("Thistle");
      expect(m.text).toContain("Spring Series 3");
      expect(m.text).toContain(when);
      expect(m.text).toContain(`${SITE}/post/${POST}`);
    }
  });

  it("a post with no match sends nothing — the accept raced or failed", async () => {
    const store = matchedStore();
    store.matches.delete(POST);
    const transport = new FakeTransport();
    expect(await notifyMatch(POST, deps(store, transport))).toBeNull();
    expect(transport.sent).toHaveLength(0);
    expect(store.logs).toHaveLength(0);
  });
});

describe("notifyMatch — the transport throws (AC 2)", () => {
  it("logs the error per recipient, throws nothing, and touched no row a caller could lose", async () => {
    const store = matchedStore();
    const transport = new FakeTransport();
    transport.refuse = true;

    // Does not throw: the match row was accept_answer()'s write and stands whatever happens here.
    const result = await notifyMatch(POST, deps(store, transport));
    expect(result).toEqual({ sent: 0, skippedCap: 0, failed: 2 });

    const logs = store.logs.filter((l) => l.kind === KIND_MATCH);
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.error).toBe("provider said no");
      expect(l.providerId).toBeNull();
    }
  });

  it("a party with no contact row is logged and skipped; the other still gets their email", async () => {
    const store = matchedStore();
    store.emails.delete(CREW);
    const transport = new FakeTransport();

    const result = await notifyMatch(POST, deps(store, transport));
    expect(result).toEqual({ sent: 1, skippedCap: 0, failed: 1 });
    expect(transport.sent.map((m) => m.to)).toEqual(["sam@example.org"]);
    const missing = store.logs.find((l) => l.personId === CREW)!;
    expect(missing.kind).toBe(KIND_MATCH);
    expect(missing.error).toBe("no contact email");
  });
});

describe("notifyMatch — the daily cap (AC 3)", () => {
  it("at the cap neither email is sent, both are logged match_skipped_cap, and nothing throws", async () => {
    const store = matchedStore();
    store.sentToday = EMAIL_SKIP_AT;
    const transport = new FakeTransport();

    const result = await notifyMatch(POST, deps(store, transport));
    expect(result).toEqual({ sent: 0, skippedCap: 2, failed: 0 });
    expect(transport.sent).toHaveLength(0);

    const skipped = store.logs.filter((l) => l.kind === KIND_MATCH_SKIPPED_CAP);
    expect(skipped).toHaveLength(2);
    expect(skipped.map((l) => l.personId).sort()).toEqual([SKIPPER, CREW].sort());
  });

  it("one below the cap sends the skipper's and skips the crew's — the per-send rule, not an atomic pair", async () => {
    const store = matchedStore();
    store.sentToday = EMAIL_SKIP_AT - 1;
    const transport = new FakeTransport();

    const result = await notifyMatch(POST, deps(store, transport));
    expect(result).toEqual({ sent: 1, skippedCap: 1, failed: 0 });
    expect(transport.sent.map((m) => m.to)).toEqual(["sam@example.org"]);
    expect(store.logs.find((l) => l.kind === KIND_MATCH_SKIPPED_CAP)!.personId).toBe(CREW);
  });
});

describe("notifyMatch — the crew's copy carries the race .ics, the skipper's none (#34 AC 2)", () => {
  it("attaches exactly one text/calendar file to the crew's email and nothing to the skipper's", async () => {
    const store = matchedStore();
    const transport = new FakeTransport();
    await notifyMatch(POST, deps(store, transport));

    const toSkipper = transport.sent.find((m) => m.to === "sam@example.org")!;
    const toCrew = transport.sent.find((m) => m.to === "robin@example.org")!;
    expect(toSkipper.attachments).toBeUndefined();
    expect(toSkipper.text).not.toContain("calendar file");

    expect(toCrew.attachments).toHaveLength(1);
    const [ics] = toCrew.attachments!;
    expect(ics.filename).toBe("race.ics");
    expect(ics.contentType).toBe(ICS_CONTENT_TYPE);
    expect(ics.contentType.startsWith("text/calendar")).toBe(true);
    // Built from THIS match: its uid, its race, its skipper — and the post URL on this site.
    expect(ics.content).toContain(`UID:${MATCH}@tender.madcowsailing.com\r\n`);
    expect(ics.content).toContain("DTSTART:20270613T170000Z\r\n");
    expect(ics.content).toContain("SUMMARY:Thistle with Sam Skipper — Hoover Sailing Club\r\n");
    expect(ics.content.replace(/\r\n /g, "")).toContain(`DESCRIPTION:Bring gloves\\n\\n${SITE}/post/${POST}`);
    expect(toCrew.text).toContain("attached as a calendar file (race.ics)");

    expect(store.calendarCalls).toEqual([MATCH]);
    expect(store.logs.filter((l) => l.kind === KIND_MATCH_ICS_FAILED)).toHaveLength(0);
  });

  it("builds no file for a crew send that does not happen — a cap skip or a missing address", async () => {
    const capped = matchedStore();
    capped.sentToday = EMAIL_SKIP_AT - 1; // the skipper's goes, the crew's is skipped
    await notifyMatch(POST, deps(capped, new FakeTransport()));
    expect(capped.calendarCalls).toEqual([]);

    const noAddress = matchedStore();
    noAddress.emails.delete(CREW);
    await notifyMatch(POST, deps(noAddress, new FakeTransport()));
    expect(noAddress.calendarCalls).toEqual([]);
  });
});

describe("notifyMatch — the .ics fails to render (#34 AC 3)", () => {
  // Three ways the file can fail, each at a different layer: the read throws, the read finds
  // nothing, and the read succeeds with a value raceIcs() refuses.
  const cases: Array<[string, (s: MemoryStore) => void, RegExp]> = [
    ["the calendar read throws", (s) => (s.calendarError = "read club name for ics: permission denied"), /permission denied/],
    ["the calendar read finds nothing", (s) => s.calendarInputs.clear(), /match not found/],
    ["the race start does not parse", (s) => (s.calendarInputs.get(MATCH)!.startsAt = "not a date"), /starts_at is not a date/],
  ];

  for (const [name, breakIt, reason] of cases) {
    it(`${name}: the crew's email still goes, without the file, and match_ics_failed says why`, async () => {
      const store = matchedStore();
      breakIt(store);
      const transport = new FakeTransport();

      const result = await notifyMatch(POST, deps(store, transport));
      expect(result).toEqual({ sent: 2, skippedCap: 0, failed: 0 });

      const toCrew = transport.sent.find((m) => m.to === "robin@example.org")!;
      expect(toCrew.attachments).toBeUndefined();
      expect(toCrew.text).not.toContain("calendar file"); // does not promise a file it lacks
      expect(toCrew.text).toContain("Sam Skipper"); // and is otherwise the whole match email

      const failed = store.logs.filter((l) => l.kind === KIND_MATCH_ICS_FAILED);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ channel: "email", personId: CREW, toEmail: "robin@example.org", postId: POST, providerId: null });
      expect(failed[0].error).toMatch(reason);

      // The send itself is logged as an ordinary accepted match email.
      const crewSend = store.logs.find((l) => l.kind === KIND_MATCH && l.personId === CREW)!;
      expect(crewSend.error).toBeNull();
      expect(crewSend.providerId).toMatch(/^sent-/);
    });
  }

  it("match_ics_failed is not an attempt on the provider, so the cap does not count it", () => {
    expect(EMAIL_ATTEMPT_KINDS).not.toContain(KIND_MATCH_ICS_FAILED);
  });
});

describe("matchMessage — the copy", () => {
  it("subject carries the boat, the class and the club-zone time", () => {
    const m = matchMessage(post(), "Robin Crew", "sam@example.org", SITE);
    expect(m.subject).toBe(`Matched: Blue Moon (Thistle), ${whenLabel("2027-06-13T17:00:00Z")}`);
  });
});
