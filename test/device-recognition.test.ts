import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  RECOGNITION_COOKIE,
  RECOGNITION_VALUE,
  RECOGNITION_MAX_AGE_S,
} from "@/auth/recognition";

/**
 * #123 AC 4 and AC 5 — the three paths that produce a session set the recognition cookie, and
 * sign-out does not clear it.
 *
 * **Why these drive the real handlers.** The criterion says *proven by a test that drives the real
 * success path rather than asserting that a call was made*, and the reason is the trap the issue
 * names: Next applies the `cookies()` store OVER the response's own `Set-Cookie` headers, so a
 * cookie set with `res.cookies.set(...)` is lost on exactly the path where a session was written
 * and survives on every path where one was not. A test that spied on `rememberDevice` would pass
 * on both spellings. The subject here is the STORE the handler wrote to, which is the thing Next
 * actually applies — so the response spelling reddens these and the store spelling does not.
 *
 * What is faked is everything outside the handler: the Supabase clients, and the cookie store
 * itself. Everything inside — the route's own branching, `passwordSignIn`, `join`, `ensurePerson`
 * — is the shipped code. That is the line, and it is drawn there because the handler's decision
 * about WHEN and HOW to write the cookie is the whole subject.
 *
 * `@/lib/supabase/admin` must be mocked rather than merely unused: it imports `server-only`, which
 * cannot be resolved under vitest, and a suite that reaches it dies at IMPORT with its tests
 * leaving the total while `pending` stays 0 — a run that reads as clean (the complete-story tender
 * overlay, from #41). The count assertion at the bottom of this file is the guard against that.
 */

// --------------------------------------------------------------------------------------------
// The fakes. Declared before the mock factories read them; the factories only close over these
// names, so the temporal order is import → factory creation → test body → first read.
// --------------------------------------------------------------------------------------------

type Written = { value: string; options: Record<string, unknown> };

/** The cookie store, as Next hands it to a handler. A Map is a complete stand-in for what it does. */
const jar = new Map<string, Written>();
const store = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
  set: (name: string, value: string, options: Record<string, unknown> = {}) => {
    jar.set(name, { value, options });
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};

/** Whatever the handler put on the RESPONSE, kept apart from the store so the two can be told apart. */
let supabase: Record<string, unknown> = {};

vi.mock("next/headers", () => ({ cookies: async () => store }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => supabase }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => supabase }));

const { POST: signinPOST } = await import("@/app/api/signin/route");
const { POST: joinPOST } = await import("@/app/api/join/route");
const { GET: callbackGET } = await import("@/app/auth/callback/route");
const { POST: signoutPOST } = await import("@/app/auth/signout/route");
const { POST: googleSigninPOST } = await import("@/app/api/signin/google/route");
const { POST: googleSignupPOST } = await import("@/app/api/signup/google/route");

/**
 * One awaitable stand-in for a PostgREST query builder. Every chain these three routes build
 * (`select().limit().single()`, `select().eq()`, `select().eq().maybeSingle()`) ends at the same
 * value, and the callers read whichever of `data` / `count` / `error` they asked for.
 */
function answers(value: Record<string, unknown>) {
  const node: Record<string, unknown> = {
    select: () => node,
    limit: () => node,
    eq: () => node,
    single: async () => value,
    maybeSingle: async () => value,
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(ok, bad),
  };
  return node;
}

const INVITE = "SPRING-2027";
const PASSWORD = "a-long-enough-password";

/** A client that answers every call these routes make the way a healthy stack would. */
function healthyStack(overrides: { personExists?: boolean } = {}) {
  const personExists = overrides.personExists ?? true;
  return {
    from: (table: string) => {
      if (table === "club") return answers({ data: { invite_code: INVITE }, error: null });
      return {
        ...answers({ data: personExists ? { id: "u1" } : null, count: personExists ? 1 : 0, error: null }),
        insert: async () => ({ error: null }),
      };
    },
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: "u1" } }, error: null }),
      // #173: a Google-created user carries no attestation of ours. On sign-in that is a stray
      // unless a person row exists; on sign-up the gate hands the attestation over itself.
      signInWithIdToken: async () => ({
        data: { user: { id: "u1", email: "ann@example.test", user_metadata: { full_name: "Ann" } } },
        error: null,
      }),
      exchangeCodeForSession: async () => ({
        data: { user: { id: "u1", email: "ann@example.test", user_metadata: { adult_attested_at: "2026-01-01T00:00:00.000Z" } } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
      admin: {
        createUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
        updateUserById: async () => ({ error: null }),
        deleteUser: async () => ({ error: null }),
        listUsers: async () => ({ data: { users: [] }, error: null }),
      },
    },
  } as Record<string, unknown>;
}

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What the store holds for the recognition cookie — `undefined` when the handler wrote nothing. */
function remembered(): Written | undefined {
  return jar.get(RECOGNITION_COOKIE);
}

beforeEach(() => {
  jar.clear();
  supabase = healthyStack();
});

// --------------------------------------------------------------------------------------------

describe("password sign-in remembers the device (#123 AC 4)", () => {
  it("writes the marker through the cookie store on a successful sign-in", async () => {
    const res = await signinPOST(post("https://tender.test/api/signin", {
      email: "ann@example.test",
      password: PASSWORD,
    }));

    expect(res.status, await res.text().catch(() => "")).toBe(200);
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
    expect(remembered()?.options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: RECOGNITION_MAX_AGE_S,
    });
  });

  it("takes `secure` from the request, so a local http stack still gets the cookie", async () => {
    await signinPOST(post("http://127.0.0.1:3000/api/signin", {
      email: "ann@example.test",
      password: PASSWORD,
    }));
    expect(remembered()?.options.secure).toBe(false);
  });

  it("remembers NOTHING when the credentials are refused — the negative control", async () => {
    // Without this, "the cookie is in the jar" is consistent with a handler that sets it on every
    // request, which would mark a device that has never successfully signed in.
    supabase = {
      ...healthyStack(),
      auth: { ...(healthyStack().auth as object), signInWithPassword: async () => ({ data: {}, error: { code: "invalid_credentials", message: "no" } }) },
    };
    const res = await signinPOST(post("https://tender.test/api/signin", {
      email: "ann@example.test",
      password: "wrong",
    }));
    expect(res.status).toBe(401);
    expect(remembered()).toBeUndefined();
  });

  it("remembers nothing for a session that is signed straight back out", async () => {
    // The 403 arm: a real session, no person row, signed out again. That is not a device that
    // signed in, and it is the case most likely to be missed by a `status < 400` check.
    supabase = healthyStack({ personExists: false });
    const res = await signinPOST(post("https://tender.test/api/signin", {
      email: "stray@example.test",
      password: PASSWORD,
    }));
    expect(res.status).toBe(403);
    expect(remembered()).toBeUndefined();
  });
});

describe("a sign-up that finishes here remembers the device (#123 AC 4)", () => {
  it("writes the marker through the store when the gate signs them in", async () => {
    supabase = healthyStack({ personExists: false });
    const res = await joinPOST(post("https://tender.test/api/join", {
      email: "new@example.test",
      displayName: "New Member",
      code: INVITE,
      attested: true,
      password: PASSWORD,
    }));

    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
    expect(remembered()?.options.path).toBe("/");
  });

  it("remembers nothing when the invite code is refused", async () => {
    const res = await joinPOST(post("https://tender.test/api/join", {
      email: "new@example.test",
      displayName: "New Member",
      code: "NOT-THIS-SEASON",
      attested: true,
      password: PASSWORD,
    }));
    expect(res.status).toBe(403);
    expect(remembered()).toBeUndefined();
  });
});

describe("the OAuth callback remembers the device (#123 AC 4)", () => {
  it("writes the marker through the store after the exchange succeeds", async () => {
    const res = await callbackGET(new NextRequest("https://tender.test/auth/callback?code=abc123"));

    expect(res.status).toBe(307);
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
    expect(remembered()?.options.httpOnly).toBe(true);
  });

  it("remembers nothing when the exchange fails", async () => {
    supabase = {
      ...healthyStack(),
      auth: {
        ...(healthyStack().auth as object),
        exchangeCodeForSession: async () => ({ data: {}, error: { message: "bad code" } }),
      },
    };
    await callbackGET(new NextRequest("https://tender.test/auth/callback?code=abc123"));
    expect(remembered()).toBeUndefined();
  });

  it("remembers nothing for a stray whose auth user was just deleted", async () => {
    // `ensurePerson` refuses a user with no attestation and no gate pass, deletes it and the
    // handler signs the session out. A device that was refused has not signed in here — and this
    // is the ordering the implementation has to get right, since the refusal happens AFTER the
    // exchange that produced the session.
    const base = healthyStack({ personExists: false });
    supabase = {
      ...base,
      auth: {
        ...(base.auth as object),
        exchangeCodeForSession: async () => ({
          data: { user: { id: "stray", email: "stray@example.test", user_metadata: {} } },
          error: null,
        }),
      },
    };
    const res = await callbackGET(new NextRequest("https://tender.test/auth/callback?code=abc123"));
    expect(res.headers.get("location")).toContain("error=not-invited");
    expect(remembered()).toBeUndefined();
  });
});

/**
 * #173: the two ID-token routes are the fourth and fifth paths that produce a session, and both
 * write the session through `cookies()` (`signInWithIdToken` on the cookie-bound client), which
 * is exactly the path where a response-level marker vanishes. Same subject, same instrument.
 */
describe("the Google ID-token routes remember the device (#123 AC 4, extended by #173)", () => {
  const GOOD = { credential: "eyJ.id.token", nonce: "raw-nonce" };

  it("sign-in writes the marker through the store when the member has a person row", async () => {
    const res = await googleSigninPOST(post("https://tender.test/api/signin/google", GOOD));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/board" });
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
    expect(remembered()?.options.path).toBe("/");
  });

  it("sign-in remembers nothing for a stray — deleted and signed back out (#173 AC 2)", async () => {
    supabase = healthyStack({ personExists: false });
    const deleted: string[] = [];
    (supabase.auth as { admin: { deleteUser: (id: string) => unknown } }).admin.deleteUser = async (id: string) => {
      deleted.push(id);
      return { error: null };
    };
    const res = await googleSigninPOST(post("https://tender.test/api/signin/google", GOOD));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: expect.stringMatching(/not linked to a member here/) });
    expect(deleted).toEqual(["u1"]);
    expect(remembered()).toBeUndefined();
  });

  it("sign-in with no token makes no call and remembers nothing", async () => {
    let touched = 0;
    // `await supabaseServer()` reads `then` off whatever it is handed — that is the await, not a
    // Supabase call, so it is the one key the counter ignores.
    supabase = new Proxy(healthyStack(), {
      get: (_t, key) => {
        if (key !== "then") touched++;
        return undefined;
      },
    }) as Record<string, unknown>;
    const res = await googleSigninPOST(post("https://tender.test/api/signin/google", {}));
    expect(res.status).toBe(400);
    expect(touched).toBe(0);
    expect(remembered()).toBeUndefined();
  });

  it("sign-up writes the marker through the store when the gate mints the row", async () => {
    supabase = healthyStack({ personExists: false });
    const res = await googleSignupPOST(post("https://tender.test/api/signup/google", {
      displayName: "Ann Crew",
      code: INVITE,
      attested: true,
      ...GOOD,
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/board" });
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
  });

  it("sign-up remembers nothing when the invite code is refused, and never reaches the exchange", async () => {
    supabase = healthyStack({ personExists: false });
    let exchanged = 0;
    (supabase.auth as { signInWithIdToken: () => unknown }).signInWithIdToken = async () => {
      exchanged++;
      return { data: { user: null }, error: null };
    };
    const res = await googleSignupPOST(post("https://tender.test/api/signup/google", {
      displayName: "Ann Crew",
      code: "NOT-THIS-SEASON",
      attested: true,
      ...GOOD,
    }));
    expect(res.status).toBe(403);
    expect(exchanged).toBe(0);
    expect(remembered()).toBeUndefined();
  });
});

describe("signing out does not forget the device (#123 AC 5)", () => {
  it("leaves the recognition cookie exactly where it was", async () => {
    // The single line that separates this story from reading the `sb-*` cookies: those are cleared
    // at sign-out, so a member who signed out deliberately would be shown Sign up — the case the
    // story exists to prevent. Asserted by driving the real handler rather than by reading the
    // source, so a clear added anywhere in the request reddens this.
    jar.set(RECOGNITION_COOKIE, { value: RECOGNITION_VALUE, options: { path: "/" } });

    const res = await signoutPOST(new NextRequest("https://tender.test/auth/signout", { method: "POST" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/join");
    expect(remembered()?.value).toBe(RECOGNITION_VALUE);
  });

  it("and the store is an instrument that CAN report a clear — the control", async () => {
    // Without this, "the cookie is still there" is consistent with a store that ignores deletes,
    // which would make the assertion above unfalsifiable.
    jar.set(RECOGNITION_COOKIE, { value: RECOGNITION_VALUE, options: {} });
    store.set(RECOGNITION_COOKIE, "", { maxAge: 0 });
    expect(remembered()?.value).toBe("");
    store.delete(RECOGNITION_COOKIE);
    expect(remembered()).toBeUndefined();
  });
});

describe("this file really ran (#41's import-death guard)", () => {
  it("imported all six handlers", () => {
    // A suite that dies at import leaves NO failure and NO pending test — its cases simply vanish
    // from the total. Naming the imports in an assertion is the cheapest thing that cannot pass
    // while the file is dead.
    for (const handler of [signinPOST, joinPOST, callbackGET, signoutPOST, googleSigninPOST, googleSignupPOST]) {
      expect(typeof handler).toBe("function");
    }
  });
});
