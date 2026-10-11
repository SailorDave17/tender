import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { NextRequest } from "next/server";
import LIST from "@/auth/common-passwords.json";
import { AFTER_SIGNUP } from "@/auth/join";
import { COMMON_PASSWORD, PASSWORD_MIN, explainResetError } from "@/auth/password";

/**
 * Story #268 (security-audit SA-R2) — a new password on the common-password list is refused, at
 * sign-up and at the reset landing, with one sentence; an unlisted one of the same length is not.
 *
 * Both entrances are driven through their REAL handlers: `POST /api/join` and the reset landing's
 * `setNewPassword` Server Action. What is faked is everything outside them — both Supabase clients,
 * the cookie store and `redirect()` — the same line `test/refused-service-reads.test.ts` draws. The
 * list is the real one: `isCommonPassword` reads `src/auth/common-passwords.json` as shipped.
 *
 * `server-only` does not resolve under vitest, and the list module, the admin client and the route
 * all import it; unmocked, this file would die at import with its tests leaving the total (#41).
 */

vi.mock("server-only", () => ({}));

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
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

const INVITE = "SPRING-2027";
/** On the list, 9 characters: rank 4 in the source. */
const LISTED = "password1";
/** The same length, and on no list this file knows of; the list test below asserts so. */
const UNLISTED = "luffingq7";

const world = {
  created: [] as string[],
  inserted: [] as string[],
  updatedPasswords: [] as string[],
  signedIn: null as string | null,
};

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

const admin = {
  from(table: string) {
    if (table === "club") return query(async () => ({ data: { invite_code: INVITE }, error: null }));
    if (table === "person") {
      const node = query(async () => ({ data: null, count: 0, error: null }));
      node.insert = async (row: { id: string }) => {
        world.inserted.push(row.id);
        return { error: null };
      };
      return node;
    }
    if (table === "person_contact") return { insert: async () => ({ error: null }) };
    throw new Error(`unexpected table ${table}`);
  },
  rpc: async (fn: string) => ({ data: fn === "begin_auth_attempt" ? "attempt-1" : null, error: null }),
  auth: {
    admin: {
      createUser: async (u: { email: string }) => {
        world.created.push(u.email);
        return { data: { user: { id: "user-1" } }, error: null };
      },
    },
  },
};

const client = {
  auth: {
    signInWithPassword: async ({ email }: { email: string }) => {
      world.signedIn = email;
      return { data: { user: { id: "user-1" } }, error: null };
    },
    getUser: async () => ({ data: { user: { id: "user-1" } } }),
    updateUser: async ({ password }: { password: string }) => {
      world.updatedPasswords.push(password);
      return { data: {}, error: null };
    },
  },
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => client }));

const { POST: joinPOST } = await import("@/app/api/join/route");
const { setNewPassword } = await import("@/app/reset-password/actions");
const { isCommonPassword, COMMON_PASSWORD_COUNT } = await import("@/auth/common-passwords");

function signUp(password: string) {
  return joinPOST(
    new NextRequest("https://tender.test/api/join", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: JSON.stringify({ email: "new@example.test", code: INVITE, attested: true, password }),
    }),
  );
}

async function reset(password: string): Promise<string> {
  const form = new FormData();
  form.set("password", password);
  form.set("confirm", password);
  try {
    await setNewPassword(form);
  } catch (e) {
    if (e instanceof Redirected) return e.url;
    throw e;
  }
  throw new Error("the action finished without redirecting");
}

beforeEach(() => {
  world.created = [];
  world.inserted = [];
  world.updatedPasswords = [];
  world.signedIn = null;
  jar.clear();
});

describe("the list is the one the README names (#268 AC 2)", () => {
  it("46,483 entries: NCSC's top 100,000 at 8+ characters, folded and de-duplicated", () => {
    expect(COMMON_PASSWORD_COUNT).toBe(46_483);
    expect(LIST.slice(0, 5)).toEqual(["123456789", "password", "12345678", "password1", "1234567890"]);
  });

  it("its shortest entry is exactly the policy minimum, so lowering PASSWORD_MIN means regenerating it", () => {
    const lengths = LIST.map((p) => [...p].length);
    expect(Math.min(...lengths)).toBe(PASSWORD_MIN);
  });

  it("every entry is stored the way the check folds a candidate: NFC, lower case, once", () => {
    expect(LIST.filter((p) => p !== p.normalize("NFC").toLowerCase())).toEqual([]);
    expect(new Set(LIST).size).toBe(LIST.length);
  });
});

describe("isCommonPassword folds the candidate as the list was folded", () => {
  it("a listed password, in any case, is common; the unlisted control of the same length is not", () => {
    expect(UNLISTED.length).toBe(LISTED.length);
    expect(isCommonPassword(LISTED)).toBe(true);
    expect(isCommonPassword("PassWord1")).toBe(true);
    expect(isCommonPassword(UNLISTED)).toBe(false);
  });

  it("a decomposed spelling matches its composed entry (NFC before the lookup)", () => {
    const composed = "йцукенгшщз";
    expect(LIST).toContain(composed);
    expect(composed.normalize("NFD")).not.toBe(composed);
    expect(isCommonPassword(composed.normalize("NFD"))).toBe(true);
  });

  it("the whole password is compared, never a part of it", () => {
    expect(isCommonPassword(`${LISTED}x`)).toBe(false);
  });
});

describe("a listed password is refused at sign-up and at reset with the same sentence (#268 AC 1)", () => {
  it("sign-up: 400 with COMMON_PASSWORD, and no user is created", async () => {
    const res = await signUp(LISTED);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: COMMON_PASSWORD });
    expect(world.created).toEqual([]);
  });

  it("reset: back to the form with the `common` reason, whose sentence is the same, and the password is not set", async () => {
    expect(await reset(LISTED)).toBe("/reset-password?error=common");
    expect(explainResetError("common")).toBe(COMMON_PASSWORD);
    expect(world.updatedPasswords).toEqual([]);
  });

  it("the unlisted password of the same length signs up, and is set at reset", async () => {
    const res = await signUp(UNLISTED);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await res.json()).toEqual({ redirect: AFTER_SIGNUP });
    expect(world.created).toEqual(["new@example.test"]);

    expect(await reset(UNLISTED)).toBe("/board");
    expect(world.updatedPasswords).toEqual([UNLISTED]);
  });
});

describe("the list never reaches the browser", () => {
  const SRC = joinPath(process.cwd(), "src");
  async function files(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = joinPath(dir, e.name);
      if (e.isDirectory()) out.push(...(await files(p)));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("the module's first statement is `import \"server-only\"`, so a client import fails the build", async () => {
    const src = await readFile(joinPath(SRC, "auth", "common-passwords.ts"), "utf8");
    expect(src.trimStart().split("\n")[0].trim()).toBe('import "server-only";');
  });

  it("no client component, and not password.ts (which the Sign up tab imports), names the list", async () => {
    const offenders: string[] = [];
    let clients = 0;
    for (const f of await files(SRC)) {
      const text = await readFile(f, "utf8");
      const isClient = /^\s*["']use client["']/.test(text);
      if (isClient) clients++;
      // An import, not a mention: password.ts's own comment names the module to say it is not here.
      const named = /(?:from|import)\s*\(?\s*["'][^"']*common-passwords/.test(text);
      if (named && (isClient || f.endsWith(joinPath("auth", "password.ts")))) offenders.push(f);
    }
    expect(clients, "the scan found the client components").toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
