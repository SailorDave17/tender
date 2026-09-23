import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #219 — the proxy's WIRING of the profile gate, driven in-process (the #123 instrument: the real
 * `proxy()` with everything outside it faked). `src/auth/gate.test.ts` proves the decision; this
 * proves the proxy feeds it the right standing: that it reads the caller's own row, that a row with
 * `profile_completed_at` null becomes a 302 to /welcome, and that the read is not spent where the
 * answer cannot depend on it — an ungated path, or a router prefetch.
 *
 * The subject is the READ as well as the redirect, because the cost the owner accepted at pickup is
 * one PostgREST call on exactly the requests that need it; a proxy that read on every request
 * would redirect identically and show up only as latency.
 */

type Row = { profile_completed_at: string | null } | null;

let claims: { sub: string } | null = null;
let row: Row = null;
let readError: unknown = null;
const reads: Array<{ table: string; column: string; id: unknown }> = [];

vi.mock("@/lib/env", () => ({ env: (name: string) => `stub-${name}` }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: claims ? { claims } : null }) },
    from: (table: string) => ({
      select: (column: string) => ({
        eq: (_col: string, id: unknown) => ({
          maybeSingle: async () => {
            reads.push({ table, column, id });
            return { data: row, error: readError };
          },
        }),
      }),
    }),
  }),
}));

const { proxy } = await import("./proxy");

const MEMBER = "11111111-1111-4111-8111-111111111111";

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
}

/** The pathname a response redirects to, or null when it lets the request through. */
function redirectedTo(res: Response): string | null {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
}

beforeEach(() => {
  claims = { sub: MEMBER };
  row = { profile_completed_at: "2026-09-22T12:00:00Z" };
  readError = null;
  reads.length = 0;
});

describe("the proxy reads the caller's own person row and gates on it (#219 AC 2)", () => {
  it("sends an unfinished member from /board to /welcome with a 302", async () => {
    row = { profile_completed_at: null };
    const res = await proxy(request("/board"));
    expect(res.status).toBe(302);
    expect(redirectedTo(res)).toBe("/welcome");
    expect(reads).toEqual([{ table: "person", column: "profile_completed_at", id: MEMBER }]);
  });

  it("lets a finished member through on /board, and sends them from /welcome to /board", async () => {
    expect(redirectedTo(await proxy(request("/board")))).toBeNull();
    expect(redirectedTo(await proxy(request("/welcome")))).toBe("/board");
  });

  it("lets an unfinished member stay on /welcome", async () => {
    row = { profile_completed_at: null };
    expect(redirectedTo(await proxy(request("/welcome")))).toBeNull();
  });

  it("lets a session with no person row land on /join, where not-invited is explained", async () => {
    row = null;
    expect(redirectedTo(await proxy(request("/join?error=not-invited")))).toBeNull();
  });

  it("fails open on a refused read: the member goes where they asked, as before #219", async () => {
    row = null;
    readError = { message: "refused" };
    expect(redirectedTo(await proxy(request("/board")))).toBeNull();
  });
});

describe("the read is spent only where the answer depends on it (#219)", () => {
  it("does not read on an ungated path", async () => {
    row = { profile_completed_at: null };
    expect(redirectedTo(await proxy(request("/support")))).toBeNull();
    expect(redirectedTo(await proxy(request("/")))).toBeNull();
    expect(reads).toEqual([]);
  });

  it("does not read on a router prefetch — the real navigation is gated when it arrives", async () => {
    row = { profile_completed_at: null };
    expect(redirectedTo(await proxy(request("/board", { "next-router-prefetch": "1" })))).toBeNull();
    expect(reads).toEqual([]);
    // The control: the same request without the header reads and redirects.
    expect(redirectedTo(await proxy(request("/board")))).toBe("/welcome");
    expect(reads).toHaveLength(1);
  });

  it("does not read with no session, and a signed-out /welcome goes to /join", async () => {
    claims = null;
    expect(redirectedTo(await proxy(request("/welcome")))).toBe("/join");
    expect(reads).toEqual([]);
  });
});

describe("a signed-out redirect opens the Sign in tab (#234)", () => {
  it("sends a signed-out /board to /join?mode=signin: the path is /join and the tab is a real query", async () => {
    claims = null;
    const res = await proxy(request("/board/2027-05-02"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    // Both halves. A target carrying `?` assigned to url.pathname would read /join%3Fmode=signin
    // here, with an empty search: a redirect to a page that does not exist.
    expect(loc.pathname).toBe("/join");
    expect(loc.search).toBe("?mode=signin");
  });

  it("drops the request's own query, and no other redirect gains one", async () => {
    claims = null;
    expect(new URL((await proxy(request("/board?date=2027-05-02"))).headers.get("location")!).search).toBe("?mode=signin");
    // A signed-in member sent elsewhere gets no query at all, as before.
    claims = { sub: MEMBER };
    row = { profile_completed_at: null };
    const welcome = new URL((await proxy(request("/board?date=2027-05-02"))).headers.get("location")!);
    expect(welcome.pathname).toBe("/welcome");
    expect(welcome.search).toBe("");
  });
});
