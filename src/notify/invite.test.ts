import { describe, expect, it } from "vitest";
import type { Message, Transport } from "@/email/send";
import { EMAIL_SKIP_AT, type LogEntry } from "./rung";
import {
  INVITE_MAX,
  KIND_INVITE,
  inviteEmail,
  parseAddressList,
  sendInvites,
  type InviteStore,
} from "./invite";

/**
 * Story #31 — the invite send, against an in-memory store and a fake transport.
 *
 * Every deny and every refusal here carries a POSITIVE CONTROL in the same test or the one beside
 * it: a refusal that sends nothing looks exactly like a call that was never made, so the
 * neighbouring case proves the fixture could have sent. That is the overlay's rule for the pglite
 * denies and it applies just as much to a pure function whose failure mode is silence.
 */

const CODE = "SPINNAKER-7";
const SITE = "https://tender.madcowsailing.com";

type Sent = Message;

function fixture(
  opts: { members?: string[]; sentToday?: number; refuse?: (to: string) => string | null } = {},
) {
  const sent: Sent[] = [];
  const logs: LogEntry[] = [];
  let nextId = 0;

  const store: InviteStore = {
    inviteCode: async () => CODE,
    members: async (emails) => {
      const held = new Set((opts.members ?? []).map((m) => m.toLowerCase()));
      return new Set(emails.filter((e) => held.has(e.toLowerCase())));
    },
    emailsSentToday: async () => opts.sentToday ?? 0,
    log: async (entry) => {
      logs.push(entry);
    },
  };

  const transport: Transport = {
    send: async (message) => {
      const refusal = opts.refuse?.(message.to) ?? null;
      if (refusal) throw new Error(refusal);
      sent.push(message);
      return { id: `re_${++nextId}` };
    },
  };

  return { store, transport, sent, logs, deps: { store, transport, now: new Date("2026-09-18T15:00:00Z"), siteUrl: SITE } };
}

describe("parsing a pasted list (AC 1)", () => {
  it("takes newlines, commas, semicolons and spaces as separators", () => {
    const { valid, malformed, duplicates } = parseAddressList(
      "a@example.org\nb@example.org, c@example.org; d@example.org e@example.org",
    );
    expect(valid.map((v) => v.email)).toEqual([
      "a@example.org",
      "b@example.org",
      "c@example.org",
      "d@example.org",
      "e@example.org",
    ]);
    expect(malformed).toEqual([]);
    expect(duplicates).toEqual([]);
  });

  it("lowercases, de-duplicates case-insensitively, and keeps first-seen order", () => {
    const { valid, duplicates } = parseAddressList("Dave@Example.org\nsue@example.org\nDAVE@example.ORG");
    expect(valid.map((v) => v.email)).toEqual(["dave@example.org", "sue@example.org"]);
    expect(duplicates).toEqual(["DAVE@example.ORG"]);
  });

  it("unwraps a display-name form rather than reading it as three malformed words", () => {
    // A paste out of a mail client's To: field. Splitting on whitespace first would make
    // "Dave", "Smith" and "<dave@example.org>" — two malformed lines on a correct paste.
    const { valid, malformed } = parseAddressList("Dave Smith <dave@example.org>\nSue <sue@example.org>");
    expect(valid.map((v) => v.email)).toEqual(["dave@example.org", "sue@example.org"]);
    expect(malformed).toEqual([]);
  });

  it("lists back what is not an address, as typed", () => {
    const { valid, malformed } = parseAddressList("good@example.org\ndave@\n@example.org\nnot an address\nx@y");
    expect(valid.map((v) => v.email)).toEqual(["good@example.org"]);
    // "not an address" splits to three words, each malformed on its own — the report names the
    // words the admin typed, which is what lets them find the line.
    expect(malformed).toEqual(["dave@", "@example.org", "not", "an", "address", "x@y"]);
  });

  it("an empty paste is empty rather than one malformed line", () => {
    expect(parseAddressList("")).toEqual({ valid: [], malformed: [], duplicates: [] });
    expect(parseAddressList("  \n\n , ; \n")).toEqual({ valid: [], malformed: [], duplicates: [] });
  });

  it("accepts the plus-aliased form the fixture accounts use", () => {
    // The live rung fixtures are plus-aliases of one Gmail account (complete-story overlay, #27),
    // so rejecting `+` would make the story untestable against production.
    const { valid, malformed } = parseAddressList("dave+crew1@gmail.com");
    expect(valid.map((v) => v.email)).toEqual(["dave+crew1@gmail.com"]);
    expect(malformed).toEqual([]);
  });
});

describe("the email itself (AC 4)", () => {
  it("carries the code and the join link exactly once each, and no other person's data", () => {
    const message = inviteEmail("newcomer@example.org", CODE, SITE);
    const occurrences = (needle: string) => message.text.split(needle).length - 1;

    expect(occurrences(CODE)).toBe(1);
    expect(occurrences(`${SITE}/join`)).toBe(1);

    // Nobody else's address is in it. The only address anywhere is the recipient's, and that is
    // in the envelope rather than the body — so the body carries no `@` at all.
    expect(message.to).toBe("newcomer@example.org");
    expect(message.text).not.toContain("@");
    // And the install steps AC 1 asks for.
    expect(message.text).toContain("Add to Home Screen");
    expect(message.text).toContain("Install app");
  });

  it("the link follows the origin it is given, so a local stack emails local links", () => {
    const local = inviteEmail("x@example.org", CODE, "http://localhost:3100");
    expect(local.text).toContain("http://localhost:3100/join");
    expect(local.text).not.toContain("madcowsailing");
  });

  it("links to the sign-up tab by name, not to plain /join (#218 AC 3)", () => {
    // The two tests above hold `${SITE}/join` as a substring, which the plain link satisfies too,
    // so neither can tell the two apart. This one reads the whole link, to the end of its line.
    const message = inviteEmail("newcomer@example.org", CODE, SITE);
    const link = message.text.split("\n").find((line) => line.startsWith("Join here: "));
    expect(link).toBe(`Join here: ${SITE}/join?mode=signup`);
  });
});

describe("sending (AC 1)", () => {
  it("sends one email per valid address and logs each as an attempt", async () => {
    const f = fixture();
    const result = await sendInvites("a@example.org\nb@example.org", f.deps);

    expect(f.sent.map((m) => m.to)).toEqual(["a@example.org", "b@example.org"]);
    expect(result.outcomes).toEqual([
      { email: "a@example.org", state: "sent", providerId: "re_1" },
      { email: "b@example.org", state: "sent", providerId: "re_2" },
    ]);
    expect(f.logs).toEqual([
      { kind: KIND_INVITE, channel: "email", personId: null, toEmail: "a@example.org", postId: null, providerId: "re_1", error: null },
      { kind: KIND_INVITE, channel: "email", personId: null, toEmail: "b@example.org", postId: null, providerId: "re_2", error: null },
    ]);
    // An invitee has no person row and no post — the columns are nullable and this is the first
    // sender to use that (0010).
    expect(f.logs.every((l) => l.personId === null && l.postId === null)).toBe(true);
  });

  it("sends the valid ones and lists the malformed back unsent", async () => {
    const f = fixture();
    const result = await sendInvites("good@example.org\ndave@\nalso@example.org", f.deps);

    expect(f.sent.map((m) => m.to)).toEqual(["good@example.org", "also@example.org"]);
    expect(result.malformed).toEqual(["dave@"]);
    // The malformed line spends no cap slot and logs nothing: it never reached the provider.
    expect(f.logs).toHaveLength(2);
  });

  it("a provider refusal is logged with its error and does not stop the rest", async () => {
    const f = fixture({ refuse: (to) => (to === "bounce@example.org" ? "invalid recipient" : null) });
    const result = await sendInvites("a@example.org\nbounce@example.org\nb@example.org", f.deps);

    expect(f.sent.map((m) => m.to)).toEqual(["a@example.org", "b@example.org"]);
    expect(result.outcomes).toEqual([
      { email: "a@example.org", state: "sent", providerId: "re_1" },
      { email: "bounce@example.org", state: "refused", error: "invalid recipient" },
      { email: "b@example.org", state: "sent", providerId: "re_2" },
    ]);
    // Three attempts on the provider, including the refused one — it was called and it counts.
    expect(f.logs).toHaveLength(3);
    expect(f.logs[1]).toMatchObject({ toEmail: "bounce@example.org", providerId: null, error: "invalid recipient" });
  });

  it("a duplicate address is sent once and reported", async () => {
    const f = fixture();
    const result = await sendInvites("dave@example.org\nDave@example.org", f.deps);
    expect(f.sent).toHaveLength(1);
    expect(result.duplicates).toEqual(["Dave@example.org"]);
  });

  it(`refuses more than ${INVITE_MAX} addresses without sending anything`, async () => {
    const f = fixture();
    const list = Array.from({ length: INVITE_MAX + 1 }, (_, i) => `p${i}@example.org`).join("\n");
    const result = await sendInvites(list, f.deps);

    expect(result.refusal).toEqual({ reason: "too_many", max: INVITE_MAX });
    expect(f.sent).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it(`sends a full ${INVITE_MAX} — the positive control on the ceiling above`, async () => {
    const f = fixture();
    const list = Array.from({ length: INVITE_MAX }, (_, i) => `p${i}@example.org`).join("\n");
    const result = await sendInvites(list, f.deps);
    expect(result.refusal).toBeUndefined();
    expect(f.sent).toHaveLength(INVITE_MAX);
  });

  it("a paste with no address in it refuses as empty and reads nothing", async () => {
    // Nothing is read: no cap call, no member call. The store would throw if either were made.
    const store: InviteStore = {
      inviteCode: async () => { throw new Error("must not read the code"); },
      members: async () => { throw new Error("must not read members"); },
      emailsSentToday: async () => { throw new Error("must not read the cap"); },
      log: async () => { throw new Error("must not log"); },
    };
    const result = await sendInvites("not an address", {
      store,
      transport: { send: async () => { throw new Error("must not send"); } },
      now: new Date(),
      siteUrl: SITE,
    });
    expect(result.refusal).toEqual({ reason: "empty" });
    expect(result.malformed).toEqual(["not", "an", "address"]);
  });
});

describe("the daily cap (AC 2)", () => {
  it("refuses the whole batch when it would not fit, and says how many would", async () => {
    // Four to send, three slots left: nothing goes, and the admin is told three.
    const f = fixture({ sentToday: EMAIL_SKIP_AT - 3 });
    const result = await sendInvites("a@example.org\nb@example.org\nc@example.org\nd@example.org", f.deps);

    expect(result.refusal).toEqual({ reason: "cap", fits: 3 });
    expect(f.sent).toEqual([]);
    // Nothing is logged for a refusal: it is not an attempt, so it must not spend slots the
    // count reads tomorrow.
    expect(f.logs).toEqual([]);
  });

  it("sends when the batch fits exactly — the positive control on the refusal above", async () => {
    const f = fixture({ sentToday: EMAIL_SKIP_AT - 3 });
    const result = await sendInvites("a@example.org\nb@example.org\nc@example.org", f.deps);
    expect(result.refusal).toBeUndefined();
    expect(f.sent).toHaveLength(3);
  });

  it("reports nought fit when the day is already spent", async () => {
    const f = fixture({ sentToday: EMAIL_SKIP_AT });
    const result = await sendInvites("a@example.org", f.deps);
    expect(result.refusal).toEqual({ reason: "cap", fits: 0 });
    expect(f.sent).toEqual([]);
  });

  it("never reports a negative number of slots when the cap is already overrun", async () => {
    const f = fixture({ sentToday: EMAIL_SKIP_AT + 20 });
    const result = await sendInvites("a@example.org", f.deps);
    expect(result.refusal).toEqual({ reason: "cap", fits: 0 });
  });

  it("counts only the addresses that would actually be sent, not the members skipped", async () => {
    // Three pasted, two of them already members, one slot left. The one send fits — and would not
    // have if the skips were counted, which is the whole reason the member read comes first.
    const f = fixture({ members: ["m1@example.org", "m2@example.org"], sentToday: EMAIL_SKIP_AT - 1 });
    const result = await sendInvites("m1@example.org\nnew@example.org\nm2@example.org", f.deps);

    expect(result.refusal).toBeUndefined();
    expect(f.sent.map((m) => m.to)).toEqual(["new@example.org"]);
  });
});

describe("already a member (AC 3)", () => {
  it("skips a member and reports them, while sending to the rest", async () => {
    const f = fixture({ members: ["old@example.org"] });
    const result = await sendInvites("old@example.org\nnew@example.org", f.deps);

    expect(f.sent.map((m) => m.to)).toEqual(["new@example.org"]);
    expect(result.outcomes).toEqual([
      { email: "old@example.org", state: "member" },
      { email: "new@example.org", state: "sent", providerId: "re_1" },
    ]);
    // One log row, for the one send. A skip is not an attempt.
    expect(f.logs).toHaveLength(1);
  });

  it("matches a member case-insensitively", async () => {
    const f = fixture({ members: ["Dave@Example.org"] });
    const result = await sendInvites("DAVE@EXAMPLE.ORG", f.deps);
    expect(f.sent).toEqual([]);
    expect(result.outcomes).toEqual([{ email: "dave@example.org", state: "member" }]);
  });

  it("a list of nothing but members sends nothing and is not a refusal", async () => {
    // Distinct from the cap and empty refusals on purpose: the admin asked for something that was
    // already true, and the page says so rather than reporting a failure.
    const f = fixture({ members: ["a@example.org", "b@example.org"] });
    const result = await sendInvites("a@example.org\nb@example.org", f.deps);

    expect(f.sent).toEqual([]);
    expect(result.refusal).toBeUndefined();
    expect(result.outcomes.every((o) => o.state === "member")).toBe(true);
  });

  it("does not read the invite code when there is nobody to send to", async () => {
    // The code is read last, after every refusal and every skip — so a no-op send cannot fail on
    // an unreadable club row.
    const f = fixture({ members: ["a@example.org"] });
    const store: InviteStore = {
      ...f.store,
      inviteCode: async () => { throw new Error("must not read the code"); },
    };
    const result = await sendInvites("a@example.org", { ...f.deps, store });
    expect(result.outcomes).toEqual([{ email: "a@example.org", state: "member" }]);
  });
});
