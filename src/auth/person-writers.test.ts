import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #220 AC 2, AC 3 and AC 4 at the ROUTE, driving the two real handlers in-process with everything
 * outside them faked (the instrument #123 introduced; `test/device-recognition.test.ts` says why
 * the mocks are shaped as they are and why `@/lib/supabase/admin` must be mocked even here).
 *
 * The subject is what each person WRITER inserts. `ensurePerson` decides that a fresh member's
 * `profile_completed_at` is NULL (`src/auth/person.test.ts`), but 0031's `default now()` means the
 * decision only reaches the database if the store's INSERT names the column — a writer that leaves
 * it out ships a member who never sees /welcome, with every unit test green (the note #219 left
 * on #220). There are two writers by design — `adminPersonStore` and `/api/join`'s inline copy,
 * which `routes-source.test.ts` reads as text — so there is one case per writer, each reading the
 * row the fake `admin.from("person").insert()` received.
 *
 * The refusals are here too, because they are claims about the route rather than the gate: a
 * request without `attested: true` is 400 and creates no auth user, on both routes.
 */

type Row = Record<string, unknown>;
const inserts: { table: string; row: Row }[] = [];
const created: Row[] = [];
let exchangedUser: Row = { id: "g-1", email: "ann@example.test", user_metadata: { full_name: "Ann Example" } };

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: (name: string, value: string) => {
    jar.set(name, value);
  },
  delete: (name: string) => {
    jar.delete(name);
  },
};

/** One awaitable stand-in for every PostgREST chain these routes build (see device-recognition.test.ts). */
function answers(value: Record<string, unknown>) {
  const node: Record<string, unknown> = {
    select: () => node,
    limit: () => node,
    eq: () => node,
    single: async () => value,
    maybeSingle: async () => value,
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(value).then(ok, bad),
  };
  return node;
}

const INVITE = "SPRING-2027";

const supabase = {
  from: (table: string) => {
    if (table === "club") return answers({ data: { invite_code: INVITE }, error: null });
    return {
      // no person row yet: the routes mint one
      ...answers({ data: null, count: 0, error: null }),
      insert: async (row: Row) => {
        inserts.push({ table, row });
        return { error: null };
      },
    };
  },
  auth: {
    signInWithPassword: async () => ({ data: { user: { id: "u1" } }, error: null }),
    signInWithIdToken: async () => ({ data: { user: exchangedUser }, error: null }),
    signOut: async () => ({ error: null }),
    admin: {
      createUser: async (u: Row) => {
        created.push(u);
        return { data: { user: { id: "u1" } }, error: null };
      },
      updateUserById: async () => ({ error: null }),
      deleteUser: async () => ({ error: null }),
      listUsers: async () => ({ data: { users: [] }, error: null }),
    },
  },
};

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => supabase }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => supabase }));

const { POST: joinPOST } = await import("@/app/api/join/route");
const { POST: googleSignupPOST } = await import("@/app/api/signup/google/route");

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const personRows = () => inserts.filter((i) => i.table === "person").map((i) => i.row);

beforeEach(() => {
  inserts.length = 0;
  created.length = 0;
  jar.clear();
  exchangedUser = { id: "g-1", email: "ann@example.test", user_metadata: { full_name: "Ann Example" } };
});

describe("/api/join — the inline person writer (#220 AC 3)", () => {
  it("a correct code and a valid email and password: one person row, attested, unfinished, provisional name; then /welcome", async () => {
    const res = await joinPOST(post("https://tender.test/api/join", {
      email: "New.Member@example.test",
      code: INVITE,
      attested: true,
      password: "a-long-enough-password",
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/welcome" });

    const rows = personRows();
    expect(rows).toHaveLength(1);
    // The column is NAMED in the insert, as null — not merely absent, which the default would fill.
    expect(Object.keys(rows[0]).sort()).toEqual(["adult_attested_at", "display_name", "id", "profile_completed_at"]);
    expect(rows[0].profile_completed_at).toBeNull();
    expect(Date.parse(String(rows[0].adult_attested_at))).not.toBeNaN();
    expect(rows[0].display_name).toBe("new.member");
    // and the contact row beside it, for the lowercased address
    expect(inserts.find((i) => i.table === "person_contact")?.row).toEqual({ person_id: "u1", email: "new.member@example.test" });
    // The auth user carries the attestation and nothing else of ours: no name was typed.
    expect(created).toHaveLength(1);
    expect(created[0].user_metadata).toEqual({ adult_attested_at: expect.any(String) });
  });

  it("a wrong code: 403, no auth user, no row (#220 AC 3)", async () => {
    const res = await joinPOST(post("https://tender.test/api/join", {
      email: "new@example.test",
      code: "NOT-THIS-SEASON",
      attested: true,
      password: "a-long-enough-password",
    }));
    expect(res.status).toBe(403);
    expect(created).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("without attested: true — absent, false, or the string 'true' — 400 and no auth user (#220 AC 2)", async () => {
    for (const attested of [undefined, false, "true", 1]) {
      const body: Record<string, unknown> = { email: "new@example.test", code: INVITE, password: "a-long-enough-password" };
      if (attested !== undefined) body.attested = attested;
      const res = await joinPOST(post("https://tender.test/api/join", body));
      expect(res.status, JSON.stringify(attested)).toBe(400);
    }
    expect(created).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("a posted displayName is ignored, not written and not refused", async () => {
    const res = await joinPOST(post("https://tender.test/api/join", {
      email: "new@example.test",
      displayName: "Typed Anyway",
      code: INVITE,
      attested: true,
      password: "a-long-enough-password",
    }));
    expect(res.status).toBe(200);
    expect(personRows()[0].display_name).toBe("new");
    expect(created[0].user_metadata).not.toHaveProperty("display_name");
  });
});

describe("/api/signup/google — adminPersonStore, the shared writer (#220 AC 4)", () => {
  const GOOD = { credential: "eyJ.id.token", nonce: "raw-nonce" };

  it("the same outcomes: one person row, attested, unfinished, the name from Google; then /welcome", async () => {
    exchangedUser = { id: "g-1", email: "Ann@example.test", user_metadata: { given_name: "Ann", full_name: "Ann Example" } };
    const res = await googleSignupPOST(post("https://tender.test/api/signup/google", { code: INVITE, attested: true, ...GOOD }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/welcome" });

    const rows = personRows();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["adult_attested_at", "display_name", "id", "profile_completed_at"]);
    expect(rows[0].profile_completed_at).toBeNull();
    expect(Date.parse(String(rows[0].adult_attested_at))).not.toBeNaN();
    // the provisional name is the Google given name when present…
    expect(rows[0].display_name).toBe("Ann");
    expect(rows[0].id).toBe("g-1");
  });

  it("…and the whole name Google sent when there is no given name — GoTrue's fixtures here never had one", async () => {
    const res = await googleSignupPOST(post("https://tender.test/api/signup/google", { code: INVITE, attested: true, ...GOOD }));
    expect(res.status).toBe(200);
    expect(personRows()[0].display_name).toBe("Ann Example");
  });

  it("a wrong code: 403, no exchange, no row", async () => {
    const res = await googleSignupPOST(post("https://tender.test/api/signup/google", { code: "NOT-THIS-SEASON", attested: true, ...GOOD }));
    expect(res.status).toBe(403);
    expect(inserts).toEqual([]);
  });

  it("without attested: true — 400, nothing exchanged, no row (#220 AC 2)", async () => {
    for (const body of [{ code: INVITE, ...GOOD }, { code: INVITE, attested: false, ...GOOD }, { code: INVITE, attested: "true", ...GOOD }]) {
      const res = await googleSignupPOST(post("https://tender.test/api/signup/google", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(inserts).toEqual([]);
  });
});
