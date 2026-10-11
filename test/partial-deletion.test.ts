import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import type { ErrorReport } from "@/notify/error";
import { AFTER_SIGNUP } from "@/auth/join";
import { AUTH_USER_NOT_DELETED, CONFIRM_VALUE } from "@/profile/delete-account";
import { as, freshDb } from "./pglite";

/**
 * Story #263 — a deletion whose auth step was refused must stay done.
 *
 * `deleteMyAccount` removes the person's rows through `delete_person()`, then asks the service role
 * to delete the auth user. When that second request is refused the auth user outlives the rows, and
 * until 0037 it kept the 18+ attestation in its `app_metadata`. `ensurePerson` reads that as "came
 * through the invite gate, finish them", so a reset link, a Google sign-in or a sign-up minted a
 * new person row for the member who had just left. Since 0037 `delete_person()` clears the
 * attestation in the same transaction as the row deletes (owner decision at pickup, 2026-10-11).
 *
 * THE FAKE'S STATE IS PGLITE, because the claim spans the database and the handlers: the
 * migration's function runs, then the real handlers read what it left. Every handler is the shipped
 * code — `deleteMyAccount`, `/auth/callback`, `/api/join`, `/api/signin/google`, and inside them
 * `deleteAccount`, `join` and `ensurePerson` — the line #123's instrument draws. What is faked is
 * the two Supabase clients, and each answers from the database:
 *
 *   - `delete_person` runs AS THE PERSON (`authenticated`, their uid as the claim), the way the
 *     cookie-bound client calls it, so the definer's own rights are what reach `auth.users`.
 *   - The service role's reads and writes of `person` run as the table OWNER. The hosted project's
 *     default privileges give service_role ALL on a new table; this harness deliberately does not
 *     reproduce them (test/pglite.ts), and grants are not this story's subject.
 *   - GoTrue's metadata lives in `auth.users.raw_app_meta_data`, and a code or ID-token exchange
 *     hands back the user AS THE DATABASE HOLDS IT NOW. That is what GoTrue does, and it is the
 *     premise this whole fix rests on. This file assumes it; the local-stack probe in the PR is
 *     what measured it. Passwords and addresses, which no migration touches, stay in a map.
 *   - `deleteUser` deletes the `auth.users` row (which cascades), or is refused on demand.
 *
 * The prediction for removing 0037's update (written before the first run): 5 red — the two SQL
 * tests that read the key back, and the reset, Google and sign-up tests. The controls stay green.
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

const reported: ErrorReport[] = [];
vi.mock("@/notify/error-live", () => ({
  reportErrorLive: async (r: ErrorReport) => {
    reported.push(r);
    return null;
  },
}));

// --------------------------------------------------------------------------------------------
// The world. Metadata in pglite; sign-in facts in a map. Reset before every test.
// --------------------------------------------------------------------------------------------

const INVITE = "SPRING-2027";
const PASSWORD = "a-long-enough-password";
const NEW_PASSWORD = "someone-elses-password";
/** An attestation from well before the test runs, so a fresh one can never be mistaken for it. */
const OLD = "2026-08-01T09:30:00.000Z";
const REFUSAL = "JWT issued at future";

let db: PGlite;

const world = {
  creds: new Map<string, { email: string; password: string }>(),
  /** The auth user the cookie-bound client is signed in as. */
  session: null as string | null,
  /** Whose auth user a reset link's code exchanges to. */
  linkFor: null as string | null,
  refuseAuthDelete: false,
  /** Admin writes to an existing auth user's metadata: the gate's stamp, or ensurePerson's. */
  stamps: 0,
  signOuts: 0,
};

type Meta = Record<string, unknown> | null;

/** The auth user as GoTrue would hand it back: metadata read from the database now. */
async function authUser(id: string) {
  const r = await db.query<{ app: Meta; usr: Meta }>(
    "select raw_app_meta_data as app, raw_user_meta_data as usr from auth.users where id = $1",
    [id],
  );
  if (!r.rows[0]) return null;
  return { id, email: world.creds.get(id)?.email ?? null, app_metadata: r.rows[0].app, user_metadata: r.rows[0].usr };
}

function idOf(email: string): string | null {
  for (const [id, c] of world.creds) if (c.email === email) return id;
  return null;
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

const admin = {
  from(table: string) {
    if (table === "club") return query(async () => ({ data: { invite_code: INVITE }, error: null }));
    if (table === "person") {
      let id = "";
      const node = query(async () => {
        const r = await db.query<{ n: number }>("select count(*)::int as n from public.person where id = $1", [id]);
        return { data: null, count: r.rows[0].n, error: null };
      });
      node.eq = (_col: string, value: string) => {
        id = value;
        return node;
      };
      node.insert = async (row: { id: string; display_name: string; adult_attested_at: string; profile_completed_at: null }) => {
        try {
          await db.query(
            "insert into public.person (id, display_name, adult_attested_at, profile_completed_at) values ($1, $2, $3, $4)",
            [row.id, row.display_name, row.adult_attested_at, row.profile_completed_at],
          );
          return { error: null };
        } catch (e) {
          return { error: { message: String(e) } };
        }
      };
      return node;
    }
    if (table === "person_contact") {
      return {
        insert: async (row: { person_id: string; email: string }) => {
          await db.query("insert into public.person_contact (person_id, email) values ($1, $2)", [row.person_id, row.email]);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
  // 0032's attempt store (#206): healthy, so the limit neither refuses nor fails open.
  rpc: async (fn: string) => ({ data: fn === "begin_auth_attempt" ? "attempt-1" : null, error: null }),
  auth: {
    admin: {
      createUser: async (u: { email: string; password: string; app_metadata: Record<string, unknown> }) => {
        if (idOf(u.email)) return { data: { user: null }, error: { code: "email_exists", message: "exists" } };
        const id = randomUUID();
        // GoTrue merges the caller's app_metadata over its own provider keys.
        await db.query("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, $2, '{}')", [
          id,
          JSON.stringify({ provider: "email", providers: ["email"], ...u.app_metadata }),
        ]);
        world.creds.set(id, { email: u.email, password: u.password });
        return { data: { user: { id } }, error: null };
      },
      listUsers: async () => {
        const r = await db.query<{ id: string }>("select id from auth.users");
        const users = await Promise.all(r.rows.map((row) => authUser(row.id)));
        return { data: { users: users.filter(Boolean) }, error: null };
      },
      updateUserById: async (id: string, attrs: { app_metadata?: Record<string, unknown>; password?: string }) => {
        world.stamps++;
        if (attrs.app_metadata) {
          await db.query(
            "update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || $2::jsonb where id = $1",
            [id, JSON.stringify(attrs.app_metadata)],
          );
        }
        if (attrs.password) world.creds.get(id)!.password = attrs.password;
        return { error: null };
      },
      deleteUser: async (id: string) => {
        if (world.refuseAuthDelete) return { error: { message: REFUSAL } };
        await db.query("delete from auth.users where id = $1", [id]);
        world.creds.delete(id);
        return { error: null };
      },
    },
  },
};

const client = {
  auth: {
    getUser: async () => ({ data: { user: world.session ? { id: world.session } : null } }),
    exchangeCodeForSession: async () => {
      const user = world.linkFor ? await authUser(world.linkFor) : null;
      if (!user) return { data: { user: null }, error: { message: "User not found" } };
      world.session = user.id;
      return { data: { user }, error: null };
    },
    // The fake Google token IS the address: GoTrue links a verified Google identity to the email
    // user that already holds it, so the exchange hands back that user.
    signInWithIdToken: async ({ token }: { token: string }) => {
      const id = idOf(token);
      const user = id ? await authUser(id) : null;
      if (!user) return { data: { user: null }, error: { message: "no user" } };
      world.session = user.id;
      return { data: { user }, error: null };
    },
    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const id = idOf(email);
      if (!id || world.creds.get(id)!.password !== password) {
        return { data: {}, error: { code: "invalid_credentials", message: "Invalid login credentials" } };
      }
      world.session = id;
      return { data: { user: { id } }, error: null };
    },
    signOut: async () => {
      world.signOuts++;
      world.session = null;
      return { error: null };
    },
  },
  // delete_person() as the person, through their own claim: the definer's rights do the rest.
  rpc: async (fn: string, args: { person_id: string }) => {
    if (fn !== "delete_person") throw new Error(`unexpected rpc ${fn}`);
    try {
      const r = await as(db, "authenticated", `select public.delete_person('${args.person_id}') as kept`, world.session ?? undefined);
      return { data: (r.rows[0] as { kept: number }).kept, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  },
};

vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => admin }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => client }));

const { GET: callbackGET } = await import("@/app/auth/callback/route");
const { POST: joinPOST } = await import("@/app/api/join/route");
const { POST: googlePOST } = await import("@/app/api/signin/google/route");
const { deleteMyAccount } = await import("@/app/profile/account-actions");

// --------------------------------------------------------------------------------------------

/** A member as the gate leaves one: an attested auth user, and (unless `row: false`) its rows. */
async function seed(email: string, opts: { row?: boolean; attestedAt?: string; password?: string } = {}): Promise<string> {
  const id = randomUUID();
  const at = opts.attestedAt ?? OLD;
  await db.query("insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values ($1, $2, $3)", [
    id,
    JSON.stringify({ provider: "email", providers: ["email"], adult_attested_at: at }),
    JSON.stringify({}),
  ]);
  world.creds.set(id, { email, password: opts.password ?? PASSWORD });
  if (opts.row !== false) {
    await db.query(
      "insert into public.person (id, display_name, adult_attested_at, profile_completed_at) values ($1, $2, $3, now())",
      [id, email.split("@")[0], at],
    );
    await db.query("insert into public.person_contact (person_id, email) values ($1, $2)", [id, email]);
  }
  return id;
}

async function persons(id: string): Promise<number> {
  return (await db.query<{ n: number }>("select count(*)::int as n from public.person where id = $1", [id])).rows[0].n;
}

/** The person row's attestation, written the way the application writes one. */
async function attestedAt(id: string): Promise<string | null> {
  const r = await db.query<{ at: string }>(
    `select to_char(adult_attested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at from public.person where id = $1`,
    [id],
  );
  return r.rows[0]?.at ?? null;
}

async function deleteAs(id: string): Promise<string> {
  world.session = id;
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

/** The deletion this story is about: rows gone, auth delete refused. The next request is healthy. */
async function partialDeletion(id: string): Promise<void> {
  world.refuseAuthDelete = true;
  expect(await deleteAs(id)).toBe("/join?deleted=partial");
  world.refuseAuthDelete = false;
  expect(await persons(id), "the rows went").toBe(0);
  expect(await authUser(id), "the auth user did not").not.toBeNull();
}

const RESET = "https://tender.test/auth/callback?code=pkce-code&next=/reset-password";

async function resetLink(id: string): Promise<URL> {
  world.linkFor = id;
  const res = await callbackGET(new NextRequest(RESET));
  expect(res.status).toBe(307);
  return new URL(res.headers.get("location")!);
}

function post(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://tender.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

const signUp = (email: string, password: string) =>
  joinPOST(post("/api/join", { email, code: INVITE, attested: true, password }));

beforeAll(async () => {
  db = await freshDb();
}, 90_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("delete from auth.users;"); // cascades to person and everything under it
  world.creds.clear();
  world.session = null;
  world.linkFor = null;
  world.refuseAuthDelete = false;
  world.stamps = 0;
  world.signOuts = 0;
  afterQueue.length = 0;
  reported.length = 0;
  jar.clear();
});

// --------------------------------------------------------------------------------------------

describe("0037 — delete_person() clears the attestation on the auth user, and only that (#263)", () => {
  it("a person deleting themself: the key leaves raw_app_meta_data, GoTrue's keys stay, user_metadata is untouched", async () => {
    const ann = await seed("ann@example.test");
    await db.query("update auth.users set raw_user_meta_data = $2 where id = $1", [
      ann,
      JSON.stringify({ display_name: "Ann", adult_attested_at: OLD }),
    ]);

    await as(db, "authenticated", `select public.delete_person('${ann}')`, ann);

    const after = await authUser(ann);
    expect(after?.app_metadata).toEqual({ provider: "email", providers: ["email"] });
    expect(after?.user_metadata, "the pre-#267 copy is inert and not this file's").toEqual({
      display_name: "Ann",
      adult_attested_at: OLD,
    });
  });

  it("an admin deleting someone else clears THAT person's attestation, and keeps the admin's", async () => {
    const ada = await seed("ada@example.test");
    const ben = await seed("ben@example.test");
    await db.query("update public.person set is_admin = true where id = $1", [ada]);

    await as(db, "authenticated", `select public.delete_person('${ben}')`, ada);

    expect(await persons(ben)).toBe(0);
    expect((await authUser(ben))?.app_metadata).not.toHaveProperty("adult_attested_at");
    expect((await authUser(ada))?.app_metadata).toHaveProperty("adult_attested_at", OLD);
  });

  it("a refused call leaves everything as it was, attestation included", async () => {
    const otto = await seed("otto@example.test");
    const ben = await seed("ben@example.test");

    await expect(as(db, "authenticated", `select public.delete_person('${ben}')`, otto)).rejects.toThrow(/only the person/);

    expect(await persons(ben)).toBe(1);
    expect((await authUser(ben))?.app_metadata).toHaveProperty("adult_attested_at", OLD);
  });
});

describe("a partial deletion, then each way back in, through the real handlers (#263 AC 1, AC 2)", () => {
  it("positive control: a whole deletion takes the auth user with it", async () => {
    const ann = await seed("ann@example.test");
    expect(await deleteAs(ann)).toBe("/join?deleted=1");
    expect(await authUser(ann)).toBeNull();
  });

  it("the reset link: no row is minted, the leftover auth user is deleted, and they are told they are not a member", async () => {
    // Joined through the real gate, so the attestation is where the gate puts it.
    expect((await signUp("ann@example.test", PASSWORD)).status).toBe(200);
    const ann = idOf("ann@example.test")!;
    expect((await authUser(ann))?.app_metadata).toHaveProperty("adult_attested_at");

    await partialDeletion(ann);
    expect((await authUser(ann))?.app_metadata, "the deletion cleared it").not.toHaveProperty("adult_attested_at");
    const signOutsBefore = world.signOuts;

    const to = await resetLink(ann);

    expect(to.pathname).toBe("/join");
    expect(to.searchParams.get("error")).toBe("not-invited");
    expect(await persons(ann), "no new person row").toBe(0);
    expect(await authUser(ann), "the leftover is gone: the reset finished the deletion").toBeNull();
    expect(world.signOuts - signOutsBefore, "the exchanged session is signed out").toBe(1);
  });

  it("a Google sign-in: refused, no row, and the leftover deleted", async () => {
    const ann = await seed("ann@example.test");
    await partialDeletion(ann);

    const res = await googlePOST(post("/api/signin/google", { credential: "ann@example.test", nonce: "raw-nonce" }));

    expect(res.status).toBe(403);
    expect(await persons(ann)).toBe(0);
    expect(await authUser(ann)).toBeNull();
  });

  it("a sign-up with this season's code makes a NEW member, exactly as after a complete deletion — never the old one back", async () => {
    // Someone holding the code types the leaver's address and a password of their own. Before 0037
    // this minted the LEAVER's row from their old attestation, then answered "already a member".
    const ann = await seed("ann@example.test", { attestedAt: OLD });
    await partialDeletion(ann);

    const res = await signUp("ann@example.test", NEW_PASSWORD);

    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await res.json()).toEqual({ redirect: AFTER_SIGNUP });
    expect(await persons(ann)).toBe(1);
    expect(await attestedAt(ann), "attested by THIS sign-up, not carried over from the deleted member").not.toBe(OLD);
    expect(world.stamps, "stamped as a stray: a fresh attestation and the new password").toBe(1);
    expect(world.session).toBe(ann);

    // The same request after a COMPLETE deletion, for the comparison the owner's decision names.
    const ben = await seed("ben@example.test");
    expect(await deleteAs(ben)).toBe("/join?deleted=1");
    const whole = await signUp("ben@example.test", NEW_PASSWORD);
    expect(whole.status).toBe(200);
    expect(await whole.json()).toEqual({ redirect: AFTER_SIGNUP });
  });
});

describe("the attested auth users with no row that SHOULD be finished still are (#263's notes)", () => {
  it("a sign-up interrupted between its two writes is finished by a reset link", async () => {
    const ann = await seed("ann@example.test", { row: false });

    const to = await resetLink(ann);

    expect(to.pathname).toBe("/reset-password");
    expect(await persons(ann)).toBe(1);
    expect(await attestedAt(ann)).toBe(OLD);
  });

  it("...and by signing up again with its own password, from its own attestation (#204)", async () => {
    const ann = await seed("ann@example.test", { row: false });

    const res = await signUp("ann@example.test", PASSWORD);

    expect(res.status).toBe(200);
    expect(await persons(ann)).toBe(1);
    expect(await attestedAt(ann)).toBe(OLD);
    expect(world.stamps, "finished, not re-stamped").toBe(0);
  });
});

describe("what the owner is told about a partial deletion (#263 AC 3)", () => {
  it("the AuthUserNotDeleted report says the leftover cannot make itself a member, never that a reset would", async () => {
    const ann = await seed("ann@example.test");
    await partialDeletion(ann);
    while (afterQueue.length) await afterQueue.shift()!();

    expect(reported.map((r) => r.name)).toEqual([AUTH_USER_NOT_DELETED]);
    expect(reported[0].message).not.toMatch(/new, empty profile/);
    expect(reported[0].message).toMatch(/password reset or a Google sign-in from that address is refused/);
  });

  it("README's removal runbook says the same", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(readme).not.toMatch(/would create a new, empty profile/);
    expect(readme).toMatch(/`0037`/);
  });
});

describe("this file really ran (#41's import-death guard)", () => {
  it("imported all four handlers", () => {
    for (const handler of [callbackGET, joinPOST, googlePOST, deleteMyAccount]) expect(typeof handler).toBe("function");
  });
});
