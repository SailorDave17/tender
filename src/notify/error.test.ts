import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/email/send";
import { EMAIL_SKIP_AT } from "./rung";
import {
  ERROR_EMAIL_WINDOW_MS,
  KIND_ERROR,
  KIND_ERROR_SKIPPED_CAP,
  STACK_LINES,
  errorEmail,
  isControlFlow,
  reportError,
  signatureOf,
  stripQuery,
  toReport,
  type ErrorLogEntry,
  type ErrorReport,
  type ErrorStore,
} from "./error";

/**
 * Story #43 — the owner's error email, against an in-memory store and a fake transport.
 *
 * AC 2 asks for the window to be unit-tested with a fake clock and stated, which is most of what
 * is below: `now` is a value this file passes in, so an hour is an hour of the story's time and
 * not of the test's. The other half of what is worth testing here is the set of BEST-EFFORT
 * paths — a store read that throws must not silence the report, because the database being
 * unreachable is one of the things the report exists to tell the owner about.
 */

const OWNER = "owner@example.org";
const T0 = new Date("2026-09-20T09:00:00.000Z");

function at(msFromT0: number): Date {
  return new Date(T0.getTime() + msFromT0);
}

function report(over: Partial<ErrorReport> = {}): ErrorReport {
  return {
    name: "TypeError",
    message: "Cannot read properties of null (reading 'id')",
    stack: ["TypeError: Cannot read properties of null", ...Array.from({ length: 40 }, (_, i) => `    at frame${i} (/var/task/x.js:${i}:1)`)].join("\n"),
    method: "GET",
    path: "/post/9f2",
    routePath: "/post/[id]",
    routeType: "render",
    digest: null,
    ...over,
  };
}

type Fake = {
  store: ErrorStore;
  rows: ErrorLogEntry[];
  sent: Message[];
  recent: Map<string, number>;
  /** Rows the store pretends were already there, as (signature, when) pairs. */
  history: { signature: string; sentAt: Date }[];
  sentToday: number;
  /** Set to make the matching read reject, the way an unreachable database does. */
  failLast?: boolean;
  failCount?: boolean;
  failLog?: boolean;
  failClaim?: boolean;
  /** Set to make the provider refuse. */
  refuse?: string;
  /** How many times the store was asked to claim a window. */
  claimCalls: number;
};

/**
 * `claims` is 0030's table: signature → the holder's instant. Pass one Map to two fakes and they
 * are two INSTANCES sharing one database — separate `recent` Maps, one claim table. The claim is
 * atomic here the way Postgres makes it atomic: the check and the write happen in one synchronous
 * step, with no await between them for another caller to land in.
 */
function fake(claims: Map<string, Date> = new Map()): Fake {
  const f: Fake = { rows: [], sent: [], recent: new Map(), history: [], sentToday: 0, claimCalls: 0, store: null as unknown as ErrorStore };
  f.store = {
    async lastErrorEmailAt(signature) {
      if (f.failLast) throw new Error("fetch failed");
      const rows = f.history.filter((h) => h.signature === signature).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
      return rows[0]?.sentAt ?? null;
    },
    async claimWindow(signature, at, since) {
      f.claimCalls++;
      if (f.failClaim) throw new Error("fetch failed");
      const held = claims.get(signature);
      if (held && held.getTime() > since.getTime()) return { won: false, heldSince: held };
      claims.set(signature, at);
      return { won: true, heldSince: at };
    },
    async emailsSentToday() {
      if (f.failCount) throw new Error("fetch failed");
      return f.sentToday;
    },
    async log(entry) {
      if (f.failLog) throw new Error("fetch failed");
      f.rows.push(entry);
    },
  };
  return f;
}

function deps(f: Fake, now: Date) {
  return {
    store: f.store,
    transport: {
      async send(message: Message) {
        if (f.refuse) throw new Error(f.refuse);
        f.sent.push(message);
        return { id: `re_${f.sent.length}` };
      },
    },
    now,
    ownerEmail: OWNER,
    recent: f.recent,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the window is one hour, and it is stated (AC 2)", () => {
  it("ERROR_EMAIL_WINDOW_MS is an hour", () => {
    expect(ERROR_EMAIL_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe("one email per error (AC 1)", () => {
  it("emails OWNER_EMAIL with the route, the name and the first 20 stack lines, and logs kind error", async () => {
    const f = fake();
    const result = await reportError(report(), deps(f, T0));

    expect(result).toEqual({ signature: "TypeError /post/[id]", state: "sent" });
    expect(f.sent).toHaveLength(1);
    const [mail] = f.sent;
    expect(mail.to).toBe(OWNER);
    expect(mail.subject).toBe("Tender error: TypeError at /post/[id]");
    expect(mail.text).toContain("/post/[id]");
    expect(mail.text).toContain("TypeError: Cannot read properties of null (reading 'id')");
    expect(mail.text).toContain("GET /post/9f2");
    // Exactly the first 20 lines of the 41-line stack, and nothing past them.
    expect(mail.text).toContain("at frame18 (");
    expect(mail.text).not.toContain("at frame19 (");
    expect(mail.text).not.toContain("at frame39 (");

    expect(f.rows).toEqual([
      { kind: KIND_ERROR, channel: "email", personId: null, toEmail: OWNER, postId: null, providerId: "re_1", error: null, signature: "TypeError /post/[id]" },
    ]);
  });

  it("takes exactly STACK_LINES lines, counted", () => {
    const mail = errorEmail(report(), OWNER, T0);
    const frames = [...mail.text.matchAll(/^ {4}at frame\d+ \(/gm)];
    // 20 lines of stack, the first of which is the `TypeError: …` header the stack itself carries.
    expect(frames).toHaveLength(STACK_LINES - 1);
  });

  it("a thrown non-Error still reports, with no stack", async () => {
    const f = fake();
    const r = toReport("boom", { path: "/board?x=1", method: "POST" }, { routePath: "/board", routeType: "action" });
    expect(r).toMatchObject({ name: "Error", message: "boom", stack: null, path: "/board", routeType: "action" });
    await reportError(r, deps(f, T0));
    expect(f.sent[0].text).toContain("(no stack)");
  });

  it("logs the provider's refusal against the same row rather than throwing", async () => {
    const f = fake();
    f.refuse = "resend 422: bad from";
    const result = await reportError(report(), deps(f, T0));
    expect(result.state).toBe("refused");
    expect(f.sent).toHaveLength(0);
    expect(f.rows[0]).toMatchObject({ kind: KIND_ERROR, providerId: null, error: "resend 422: bad from" });
  });
});

describe("the same signature within an hour is not emailed twice (AC 2)", () => {
  it("suppresses in process for 59 minutes and sends again at 60", async () => {
    const f = fake();
    expect((await reportError(report(), deps(f, at(0)))).state).toBe("sent");
    expect((await reportError(report(), deps(f, at(1_000)))).state).toBe("suppressed");
    expect((await reportError(report(), deps(f, at(59 * 60_000)))).state).toBe("suppressed");
    expect(f.sent).toHaveLength(1);

    // One millisecond short of the hour is still inside it; the hour itself is not.
    expect((await reportError(report(), deps(f, at(ERROR_EMAIL_WINDOW_MS - 1)))).state).toBe("suppressed");
    expect((await reportError(report(), deps(f, at(ERROR_EMAIL_WINDOW_MS)))).state).toBe("sent");
    expect(f.sent).toHaveLength(2);
  });

  it("the signature is the name and the ROUTE, so a different post is the same error and a different name is not", async () => {
    const f = fake();
    expect(signatureOf(report())).toBe("TypeError /post/[id]");
    await reportError(report(), deps(f, at(0)));
    // Same route template, different concrete path and a different message: one error.
    expect((await reportError(report({ path: "/post/aaa", message: "something else" }), deps(f, at(60_000)))).state).toBe("suppressed");
    // Different error name on the same route: a second error.
    expect((await reportError(report({ name: "RangeError" }), deps(f, at(60_000)))).state).toBe("sent");
    // Same name on a different route: also a second error.
    expect((await reportError(report({ routePath: "/board" }), deps(f, at(60_000)))).state).toBe("sent");
    expect(f.sent).toHaveLength(3);
  });

  it("a COLD instance is still quiet, because the log carries the window across instances", async () => {
    const f = fake();
    // Nothing in memory — a fresh lambda — but the row is in notification_log 20 minutes ago.
    f.history.push({ signature: "TypeError /post/[id]", sentAt: at(-20 * 60_000) });
    const result = await reportError(report(), deps(f, at(0)));
    expect(result).toEqual({ signature: "TypeError /post/[id]", state: "suppressed", suppressedBy: "log" });
    expect(f.sent).toHaveLength(0);
    // and it is remembered in process, so the next occurrence costs no read at all
    f.failLast = true;
    expect((await reportError(report(), deps(f, at(60_000)))).suppressedBy).toBe("memory");
  });

  it("a logged attempt older than the window does not suppress", async () => {
    const f = fake();
    f.history.push({ signature: "TypeError /post/[id]", sentAt: at(-ERROR_EMAIL_WINDOW_MS) });
    expect((await reportError(report(), deps(f, at(0)))).state).toBe("sent");
  });

  it("a REFUSED attempt starts the window too — the symptom will recur, the refusal would repeat", async () => {
    const f = fake();
    f.refuse = "resend 429: too many requests";
    expect((await reportError(report(), deps(f, at(0)))).state).toBe("refused");
    f.refuse = undefined;
    expect((await reportError(report(), deps(f, at(60_000)))).state).toBe("suppressed");
  });

  it("prunes expired signatures so a long-lived instance does not grow without bound", async () => {
    const f = fake();
    await reportError(report({ routePath: "/a" }), deps(f, at(0)));
    await reportError(report({ routePath: "/b" }), deps(f, at(0)));
    expect(f.recent.size).toBe(2);
    await reportError(report({ routePath: "/c" }), deps(f, at(ERROR_EMAIL_WINDOW_MS)));
    expect([...f.recent.keys()]).toEqual(["TypeError /c"]);
  });
});

describe("the day's cap (AC 3)", () => {
  it("at the cap: no email, a console.error, and a skipped row", async () => {
    const f = fake();
    f.sentToday = EMAIL_SKIP_AT;
    const result = await reportError(report(), deps(f, T0));
    expect(result.state).toBe("skipped_cap");
    expect(f.sent).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("cap reached"));
    expect(f.rows).toEqual([
      { kind: KIND_ERROR_SKIPPED_CAP, channel: "email", personId: null, toEmail: OWNER, postId: null, providerId: null, error: null, signature: "TypeError /post/[id]" },
    ]);
  });

  it("one under the cap still sends", async () => {
    const f = fake();
    f.sentToday = EMAIL_SKIP_AT - 1;
    expect((await reportError(report(), deps(f, T0))).state).toBe("sent");
  });

  it("the cap does not eat the five-slot identity headroom", () => {
    // EMAIL_SKIP_AT, not EMAIL_DAY_CAP: password resets are sent outside this log.
    expect(EMAIL_SKIP_AT).toBe(95);
  });

  it("a skipped report still starts the window, so a capped day is not a storm of skipped rows", async () => {
    const f = fake();
    f.sentToday = EMAIL_SKIP_AT;
    await reportError(report(), deps(f, at(0)));
    expect((await reportError(report(), deps(f, at(60_000)))).state).toBe("suppressed");
    expect(f.rows).toHaveLength(1);
  });
});

describe("concurrent reports of one error send once (#198)", () => {
  // The case measured on 2026-09-22: ONE refused read of `club`, one request, one instance — and
  // two report emails 4 ms apart, because the in-process window was written only after two
  // awaited reads. Supabase's edge log showed the pair: two dedupe reads 18 ms apart, two log
  // writes 6 ms apart.

  it("two at once on ONE instance, with the database down: one email — the in-process window alone", async () => {
    // Every store call fails, so nothing but the Map can stop the second report. This is the case
    // that isolates the in-process fix: with the claim working, the claim would catch it too.
    const f = fake();
    f.failLast = true;
    f.failCount = true;
    f.failClaim = true;
    const results = await Promise.all([reportError(report(), deps(f, T0)), reportError(report(), deps(f, at(4)))]);
    expect(f.sent).toHaveLength(1);
    expect(results.map((r) => r.state).sort()).toEqual(["sent", "suppressed"]);
    expect(results.find((r) => r.state === "suppressed")?.suppressedBy).toBe("memory");
  });

  it("two at once on ONE instance, database up: the second never reaches the store at all", async () => {
    const f = fake();
    const results = await Promise.all([reportError(report(), deps(f, T0)), reportError(report(), deps(f, at(4)))]);
    expect(f.sent).toHaveLength(1);
    expect(results.map((r) => r.suppressedBy).filter(Boolean)).toEqual(["memory"]);
    expect(f.claimCalls, "one claim, from the report that sent").toBe(1);
  });

  it("two INSTANCES at once — separate memory, one database: one email, the other lost the claim", async () => {
    // The log read cannot help here: neither attempt's row exists until its send has finished, so
    // both instances read "nothing in the last hour". The claim is what decides.
    const claims = new Map<string, Date>();
    const a = fake(claims);
    const b = fake(claims);
    const results = await Promise.all([reportError(report(), deps(a, T0)), reportError(report(), deps(b, at(4)))]);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect(results.map((r) => r.state).sort()).toEqual(["sent", "suppressed"]);
    expect(results.find((r) => r.state === "suppressed")?.suppressedBy).toBe("claim");
  });

  it("a second instance an hour later claims again — the window is an hour, not forever", async () => {
    const claims = new Map<string, Date>();
    const a = fake(claims);
    const b = fake(claims);
    expect((await reportError(report(), deps(a, T0))).state).toBe("sent");
    expect((await reportError(report(), deps(b, at(ERROR_EMAIL_WINDOW_MS - 1)))).suppressedBy).toBe("claim");
    const c = fake(claims);
    expect((await reportError(report(), deps(c, at(ERROR_EMAIL_WINDOW_MS)))).state).toBe("sent");
  });

  it("the loser's in-process window ends when the HOLDER's does, not an hour after its own occurrence", async () => {
    const claims = new Map<string, Date>([["TypeError /post/[id]", at(-50 * 60_000)]]);
    const b = fake(claims);
    expect((await reportError(report(), deps(b, T0))).suppressedBy).toBe("claim");
    expect(b.recent.get("TypeError /post/[id]")).toBe(at(-50 * 60_000).getTime());
    // Ten minutes and a second later the holder's hour is over, and this instance may send.
    expect((await reportError(report(), deps(b, at(10 * 60_000 + 1_000)))).state).toBe("sent");
  });

  it("the claim is asked for the hour before `now`, from the caller's clock", async () => {
    const f = fake();
    const asked: { at: Date; since: Date }[] = [];
    const claim = f.store.claimWindow;
    f.store.claimWindow = (sig, atArg, since) => {
      asked.push({ at: atArg, since });
      return claim(sig, atArg, since);
    };
    await reportError(report(), deps(f, T0));
    expect(asked).toEqual([{ at: T0, since: at(-ERROR_EMAIL_WINDOW_MS) }]);
  });
});

describe("the database being down is what this exists to report, so its reads are best-effort", () => {
  it("a dedupe read that throws still sends", async () => {
    const f = fake();
    f.failLast = true;
    expect((await reportError(report(), deps(f, T0))).state).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("a cap read that throws still sends", async () => {
    const f = fake();
    f.failCount = true;
    expect((await reportError(report(), deps(f, T0))).state).toBe("sent");
  });

  it("a log write that throws does not lose the email that already went", async () => {
    const f = fake();
    f.failLog = true;
    expect((await reportError(report(), deps(f, T0))).state).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("a claim that throws still sends", async () => {
    const f = fake();
    f.failClaim = true;
    expect((await reportError(report(), deps(f, T0))).state).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("with every read failing, the in-process window is still the bound — one an hour, not one a request", async () => {
    const f = fake();
    f.failLast = true;
    f.failCount = true;
    f.failLog = true;
    f.failClaim = true;
    for (let i = 0; i < 25; i++) await reportError(report(), deps(f, at(i * 1_000)));
    expect(f.sent).toHaveLength(1);
  });
});

describe("what is not an error", () => {
  it("notFound() and redirect() are control flow, not incidents", async () => {
    const f = fake();
    for (const digest of ["NEXT_NOT_FOUND", "NEXT_REDIRECT;replace;/join;307", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      expect(isControlFlow(report({ digest }))).toBe(true);
      expect((await reportError(report({ digest }), deps(f, T0))).state).toBe("ignored");
    }
    // The same values when React never set a digest and the message carries the mark instead.
    expect(isControlFlow(report({ message: "NEXT_REDIRECT;push;/board;307" }))).toBe(true);
    // A positive control: an ordinary error with a digest of its own is NOT control flow.
    expect(isControlFlow(report({ digest: "2481003457" }))).toBe(false);
    expect(f.sent).toHaveLength(0);
  });

  it("a deployment with no OWNER_EMAIL says so in the log and writes no row", async () => {
    const f = fake();
    const result = await reportError(report(), { ...deps(f, T0), ownerEmail: null });
    expect(result.state).toBe("unconfigured");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("OWNER_EMAIL unset"));
    expect(f.rows).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
  });
});

describe("no secret from a query string reaches the inbox or the log (owner decision, 2026-09-20)", () => {
  it("strips the query and the fragment", () => {
    expect(stripQuery("/auth/callback?code=pkce_7f3a&next=/board")).toBe("/auth/callback");
    expect(stripQuery("/join#code=abc")).toBe("/join");
    expect(stripQuery("/board")).toBe("/board");
    expect(stripQuery("")).toBe("");
  });

  it("toReport strips it, so nothing downstream has to remember to", async () => {
    const f = fake();
    const r = toReport(new TypeError("boom"), { path: "/auth/callback?code=pkce_7f3a", method: "GET" }, { routePath: "/auth/callback", routeType: "render" });
    expect(r.path).toBe("/auth/callback");
    await reportError(r, deps(f, T0));
    expect(f.sent[0].text).not.toContain("pkce_7f3a");
    expect(f.rows[0].signature).not.toContain("pkce_7f3a");
  });

  it("falls back to the stripped path when Next gives no routePath", () => {
    expect(toReport(new Error("x"), { path: "/api/ladder/tick?secret=s3cret", method: "POST" }, { routePath: "", routeType: "route" }).routePath).toBe("/api/ladder/tick");
  });
});
