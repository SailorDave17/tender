import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ErrorReport } from "@/notify/error";
import { CALLBACK_UNCONFIRMED_ERROR } from "@/auth/callback";
import { ALREADY_A_MEMBER, AFTER_SIGNUP } from "@/auth/join";
import { RECOGNITION_COOKIE } from "@/auth/recognition";
import { AUTH_USER_NOT_DELETED, CONFIRM_VALUE } from "@/profile/delete-account";

/**
 * Story #204 AC 4 — the three service-role callers that failed on a transient refusal when they
 * should not, each driven through its REAL handler: /auth/callback, the account-deletion action,
 * and /api/join.
 *
 * The refusal is the one production saw on 2026-09-22 — `401 PGRST303 JWT issued at future` on 1
 * of 477 service-key requests (#198) — answered by the fake service-role client on demand. What is
 * faked is everything outside the handlers: both Supabase clients, the cookie store, `after()`
 * (collected, so "reported after the response" is two assertions either side of the drain), the
 * reporter (recorded instead of emailing) and `redirect()` (thrown as a value the test can read).
 * Everything inside — the routes' branching, `ensurePerson`, `join`, `deleteAccount` — is the
 * shipped code, the same line `test/device-recognition.test.ts` draws (#123's instrument).
 *
 * THE FAKE KEEPS STATE between requests, because (b) is about a SECOND request: a sign-up refused
 * between its two writes leaves an auth user and no person row, and the claim is that the member's
 * retry finishes it. A stateless fake can only assert that a branch exists, never that the state
 * one request leaves is the state the next one can finish from.
 *
 * Every handler here imports `server-only` somewhere (the admin client, the reporter), which does
 * not resolve under vitest; a suite that reaches it dies at import with its tests leaving the total
 * and `pending` at 0 (#41). The count guard at the bottom is what cannot pass on a dead file.
 */

vi.mock("server-only", () => ({}));

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterQueue.push(task);
  },
}));

/** What `redirect()` throws here: the URL, readable, where Next would throw its control-flow error. */
class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => {
    jar.set(name, value);
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};
vi.mock("next/headers", () => ({ cookies: async () => cookieStore, headers: async () => new Headers() }));

// --------------------------------------------------------------------------------------------
// The world both clients read and write. Reset before every test.
// --------------------------------------------------------------------------------------------

type AuthUser = { id: string; email: string; password: string; user_metadata: Record<string, unknown> };

const INVITE = "SPRING-2027";
const PASSWORD = "a-long-enough-password";
const REFUSAL = "JWT issued at future";

const world = {
  users: new Map<string, AuthUser>(),
  rows: new Set<string>(),
  /** How many service-role reads of `person` to refuse, next first. */
  refusePersonReads: 0,
  /** Whether a refused read answers an error, or the query itself throws (a dropped connection). */
  refusalThrows: false,
  /** How the service role's `deleteUser` answers. */
  deleteUser: "ok" as "ok" | "refused" | "throws",
  /** The user a callback's code exchanges to, and the user the cookie-bound client is signed in as. */
  sessionUser: null as AuthUser | null,
  signOuts: 0,
  signIns: 0,
  nextId: 1,
};

function resetWorld() {
  world.users.clear();
  world.rows.clear();
  world.refusePersonReads = 0;
  world.refusalThrows = false;
  world.deleteUser = "ok";
  world.sessionUser = null;
  world.signOuts = 0;
  world.signIns = 0;
  world.nextId = 1;
}

/** A thenable query node: every chain these handlers build ends at the value `answer()` gives. */
function query(answer: () => Promise<Record<string, unknown>>) {
  const node: Record<string, unknown> = {
    select: () => node,
    limit: () => node,
    eq: () => node,
    single: answer,
    maybeSingle: answer,
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => answer().then(ok, bad),
  };
  return node;
}

/** The service role's read of `person` by id — the read `ensurePerson` opens with. */
async function personRead(id: string): Promise<Record<string, unknown>> {
  if (world.refusePersonReads > 0) {
    world.refusePersonReads--;
    if (world.refusalThrows) throw new TypeError("fetch failed");
    return { data: null, count: null, error: { message: REFUSAL, code: "PGRST303" } };
  }
  return { data: null, count: world.rows.has(id) ? 1 : 0, error: null };
}

const admin = {
  from(table: string) {
    if (table === "club") return query(async () => ({ data: { invite_code: INVITE }, error: null }));
    if (table === "person") {
      let id = "";
      const node = query(async () => personRead(id));
      node.eq = (_col: string, value: string) => {
        id = value;
        return node;
      };
      node.insert = async (row: { id: string }) => {
        world.rows.add(row.id);
        return { error: null };
      };
      return node;
    }
    if (table === "person_contact") return { insert: async () => ({ error: null }) };
    throw new Error(`unexpected table ${table}`);
  },
  // 0032's attempt store (#206): healthy, so the limit neither refuses nor fails open.
  rpc: async (fn: string) => ({ data: fn === "begin_auth_attempt" ? "attempt-1" : null, error: null }),
  auth: {
    admin: {
      createUser: async (u: { email: string; password: string; user_metadata: Record<string, unknown> }) => {
        if (world.users.has(u.email)) return { data: { user: null }, error: { code: "email_exists", message: "exists" } };
        const user = { id: `user-${world.nextId++}`, email: u.email, password: u.password, user_metadata: u.user_metadata };
        world.users.set(u.email, user);
        return { data: { user: { id: user.id } }, error: null };
      },
      listUsers: async () => ({
        data: { users: [...world.users.values()].map(({ id, email, user_metadata }) => ({ id, email, user_metadata })) },
        error: null,
      }),
      updateUserById: async () => ({ error: null }),
      deleteUser: async () => {
        if (world.deleteUser === "throws") throw new TypeError("fetch failed");
        if (world.deleteUser === "refused") return { error: { message: REFUSAL } };
        return { error: null };
      },
    },
  },
};

const client = {
  auth: {
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      world.signIns++;
      const u = world.users.get(email);
      if (!u || u.password !== password) return { data: {}, error: { code: "invalid_credentials", message: "Invalid login credentials" } };
      world.sessionUser = u;
      return { data: { user: { id: u.id } }, error: null };
    },
    exchangeCodeForSession: async () => ({ data: { user: world.sessionUser }, error: null }),
    getUser: async () => ({ data: { user: world.sessionUser ? { id: world.sessionUser.id } : null } }),
    signOut: async () => {
      world.signOuts++;
      return { error: null };
    },
  },
  rpc: async () => ({ data: 0, error: null }),
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => client }));

const reported: ErrorReport[] = [];
vi.mock("@/notify/error-live", () => ({
  reportErrorLive: async (r: ErrorReport) => {
    reported.push(r);
    return null;
  },
}));

const { GET: callbackGET } = await import("@/app/auth/callback/route");
const { POST: joinPOST } = await import("@/app/api/join/route");
const { deleteMyAccount } = await import("@/app/profile/account-actions");

/** Run what `after()` was handed, the way Next does once the response has gone. */
async function drainAfter(): Promise<void> {
  while (afterQueue.length) await afterQueue.shift()!();
}

/** An attested member's auth user, as a sign-up through the gate leaves it. */
function member(email = "ann@example.test"): AuthUser {
  const u = { id: `user-${world.nextId++}`, email, password: PASSWORD, user_metadata: { adult_attested_at: "2026-08-01T09:30:00.000Z" } };
  world.users.set(email, u);
  return u;
}

function joinRequest(password = PASSWORD): NextRequest {
  return new NextRequest("https://tender.test/api/join", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
    body: JSON.stringify({ email: "new@example.test", code: INVITE, attested: true, password }),
  });
}

const RESET = "https://tender.test/auth/callback?code=pkce-secret-123&next=/reset-password";
const LINK = "https://tender.test/auth/callback?code=pkce-secret-123&flow=link";

beforeEach(() => {
  resetWorld();
  afterQueue.length = 0;
  reported.length = 0;
  jar.clear();
});

// --------------------------------------------------------------------------------------------

describe("(a) /auth/callback goes back with a reason when it cannot check the person (#204)", () => {
  it("a reset link: signed out, sent to /join with the reason, and nothing marks the device", async () => {
    world.sessionUser = member();
    world.rows.add(world.sessionUser.id);
    world.refusePersonReads = 1;

    const res = await callbackGET(new NextRequest(RESET));

    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/join");
    expect(to.searchParams.get("error")).toBe("unconfirmed");
    expect(world.signOuts, "a session nothing confirmed is signed out").toBe(1);
    expect(jar.has(RECOGNITION_COOKIE)).toBe(false);
  });

  it("...and it is reported after the response, without the link's code", async () => {
    world.sessionUser = member();
    world.refusePersonReads = 1;
    await callbackGET(new NextRequest(RESET));

    expect(reported, "nothing is sent while the response is built").toEqual([]);
    await drainAfter();
    expect(reported).toHaveLength(1);
    expect(reported[0].name).toBe(CALLBACK_UNCONFIRMED_ERROR);
    expect(reported[0].message).toContain(REFUSAL);
    expect(JSON.stringify(reported[0])).not.toContain("pkce-secret-123");
  });

  it("a Google link from /profile: the session is kept, and the member goes back to /profile with the reason", async () => {
    world.sessionUser = member();
    world.rows.add(world.sessionUser.id);
    world.refusePersonReads = 1;

    const res = await callbackGET(new NextRequest(LINK));

    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/profile");
    expect(to.searchParams.get("error")).toBe("unconfirmed");
    expect(world.signOuts).toBe(0);
    await drainAfter();
    expect(reported.map((r) => r.name)).toEqual([CALLBACK_UNCONFIRMED_ERROR]);
  });

  it("a query that THROWS instead of answering an error is the same refusal", async () => {
    world.sessionUser = member();
    world.refusePersonReads = 1;
    world.refusalThrows = true;

    const res = await callbackGET(new NextRequest(RESET));

    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("unconfirmed");
    await drainAfter();
    expect(reported[0].message).toContain("fetch failed");
  });

  it("positive control: a readable person row lands on `next`, signed in, with nothing reported", async () => {
    world.sessionUser = member();
    world.rows.add(world.sessionUser.id);

    const res = await callbackGET(new NextRequest(RESET));

    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/reset-password");
    expect(to.searchParams.get("error")).toBeNull();
    expect(world.signOuts).toBe(0);
    expect(jar.has(RECOGNITION_COOKIE)).toBe(true);
    await drainAfter();
    expect(reported).toEqual([]);
  });
});

describe("(c) a partial account deletion tells the owner, as /join says it has (#204)", () => {
  async function deleteAs(user: AuthUser): Promise<string> {
    world.sessionUser = user;
    const form = new FormData();
    form.set("confirm", CONFIRM_VALUE);
    try {
      await deleteMyAccount(form);
    } catch (e) {
      if (e instanceof Redirected) return e.url;
      throw e;
    }
    throw new Error("the action finished without redirecting");
  }

  it("a refused auth delete lands on /join?deleted=partial and reports the auth user to remove, after the response", async () => {
    const ann = member();
    world.deleteUser = "refused";

    expect(await deleteAs(ann)).toBe("/join?deleted=partial");
    expect(reported).toEqual([]);
    await drainAfter();
    expect(reported).toHaveLength(1);
    expect(reported[0].name).toBe(AUTH_USER_NOT_DELETED);
    expect(reported[0].message).toContain(`Remove auth user ${ann.id}`);
    expect(reported[0].message).toContain(REFUSAL);
  });

  it("a delete that THROWS is the same partial deletion — not the error screen after the rows are gone", async () => {
    const ann = member();
    world.deleteUser = "throws";

    expect(await deleteAs(ann)).toBe("/join?deleted=partial");
    await drainAfter();
    expect(reported.map((r) => r.name)).toEqual([AUTH_USER_NOT_DELETED]);
    expect(reported[0].message).toContain("fetch failed");
  });

  it("positive control: a whole deletion lands on /join?deleted=1 and reports nothing", async () => {
    expect(await deleteAs(member())).toBe("/join?deleted=1");
    await drainAfter();
    expect(reported).toEqual([]);
  });
});

describe("(b) a sign-up refused between its two writes is finished by the member's retry (#204)", () => {
  it("the first request fails with an auth user and no row; the same form posted again lands on /welcome", async () => {
    world.refusePersonReads = 1;

    // The refused read throws out of the handler, which is Next's error hook's to report (#43) —
    // the form shows its "Something went wrong." and the member presses the button again.
    await expect(joinPOST(joinRequest())).rejects.toThrow(REFUSAL);
    const ann = world.users.get("new@example.test")!;
    expect(ann, "the first request created the auth user").toBeDefined();
    expect(world.rows.has(ann.id), "...and no person row").toBe(false);

    const retry = await joinPOST(joinRequest());
    expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(200);
    expect(await retry.json()).toEqual({ redirect: AFTER_SIGNUP });
    expect(world.rows.has(ann.id)).toBe(true);
    expect(world.sessionUser?.id).toBe(ann.id);
  });

  it("once finished, the address is a member's: a third post is told to sign in, and tries no password", async () => {
    world.refusePersonReads = 1;
    await expect(joinPOST(joinRequest())).rejects.toThrow(REFUSAL);
    await joinPOST(joinRequest());
    const signInsBefore = world.signIns;

    const third = await joinPOST(joinRequest("any-other-password"));
    expect(third.status).toBe(409);
    expect(await third.json()).toEqual({ message: ALREADY_A_MEMBER, then: "signin" });
    expect(world.signIns).toBe(signInsBefore);
  });
});

describe("this file really ran (#41's import-death guard)", () => {
  it("imported all three handlers", () => {
    for (const handler of [callbackGET, joinPOST, deleteMyAccount]) expect(typeof handler).toBe("function");
  });
});
