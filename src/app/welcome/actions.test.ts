import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #219 AC 3 — /welcome's Server Action, driven in-process with the cookie-bound client faked.
 *
 * The subject is what the action WRITES, recorded per table, and where it sends the member. The
 * refusal half of the criterion is "nothing is written", so every refusal case asserts an empty
 * write log rather than only the redirect — a refusal that redirected after writing the name would
 * pass a redirect-only test. RLS itself is not faked here; test/person.test.ts proves the policy
 * and the grants against 0031 in pglite (AC 1, AC 4).
 */

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

type Write = { table: string; values: Record<string, unknown>; where: [string, unknown] };
const writes: Write[] = [];
let user: { id: string } | null = null;
/** Rows each table's update reports as changed — 0 is how RLS refuses an update. */
let changed: Record<string, number> = {};

const SKILL_ROWS = [
  { code: "never-raced", label: "Never raced", level: 1, sort: 1 },
  { code: "hike-trim", label: "Can hike and trim", level: 2, sort: 2 },
  { code: "helm", label: "Can helm", level: 4, sort: 4 },
];

const client = {
  auth: { getUser: async () => ({ data: { user } }) },
  from: (table: string) => ({
    select: () => ({ order: async () => ({ data: table === "skill" ? SKILL_ROWS : [] }) }),
    update: (values: Record<string, unknown>) => ({
      eq: async (col: string, id: unknown) => {
        writes.push({ table, values, where: [col, id] });
        return { error: null, count: changed[table] ?? 1 };
      },
    }),
  }),
};

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => client }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

const { finishProfile } = await import("./actions");

const ME = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) f.append(k, x);
  return f;
}

/** Run the action and return where it redirected — it always does, success or refusal. */
async function submit(fields: Record<string, string | string[]>): Promise<string> {
  try {
    await finishProfile(form(fields));
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
  throw new Error("finishProfile returned without redirecting");
}

beforeEach(() => {
  writes.length = 0;
  user = { id: ME };
  changed = {};
});

describe("/welcome refuses a bad name and writes nothing (#219 AC 3)", () => {
  it("an empty name: refused with a message, no write at all", async () => {
    expect(await submit({ displayName: "", phone: "614-555-0100" })).toBe("/welcome?error=name-blank");
    expect(writes).toEqual([]);
  });

  it("an 81-character name: refused with a message, no write at all", async () => {
    expect(await submit({ displayName: "a".repeat(81) })).toBe("/welcome?error=name-too-long");
    expect(writes).toEqual([]);
  });

  it("a bad optional field is refused before the name is written, too", async () => {
    expect(await submit({ displayName: "Ann", phone: "555" })).toBe("/welcome?error=phone-invalid");
    expect(writes).toEqual([]);
  });
});

describe("/welcome finishes the profile and lands on /board (#219 AC 3)", () => {
  it("a valid name with the optional fields empty writes display_name and profile_completed_at, then /board", async () => {
    const before = Date.now();
    expect(await submit({ displayName: "  Ann Lee ", phone: "" })).toBe("/board");
    const person = writes.filter((w) => w.table === "person");
    expect(person).toHaveLength(1);
    expect(person[0].where).toEqual(["id", ME]);
    expect(person[0].values.display_name).toBe("Ann Lee");
    const stamped = Date.parse(String(person[0].values.profile_completed_at));
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
    // No experience ticked, so the rating is left alone rather than written as anything.
    expect(person[0].values).not.toHaveProperty("rating");
    expect(person[0].values).not.toHaveProperty("skills");
  });

  it("writes the person row LAST, so a refused contact write leaves the member unfinished", async () => {
    await submit({ displayName: "Ann", phone: "614-555-0100" });
    expect(writes.map((w) => w.table)).toEqual(["person_contact", "person"]);

    writes.length = 0;
    changed = { person_contact: 0 };
    expect(await submit({ displayName: "Ann", phone: "614-555-0100" })).toBe("/welcome?error=refused");
    expect(writes.map((w) => w.table)).toEqual(["person_contact"]);
  });

  it("ticked experience sets the rating from the highest skill, as /profile does", async () => {
    expect(await submit({ displayName: "Ann", skills: ["hike-trim", "helm"] })).toBe("/board");
    const person = writes.find((w) => w.table === "person")!;
    expect(person.values).toMatchObject({ rating: 4, skills: ["hike-trim", "helm"] });
  });

  it("Skip for now writes the name and the stamp and nothing optional", async () => {
    expect(await submit({ displayName: "Ann", skills: ["helm"], phone: "614-555-0100", skip: "1" })).toBe("/board");
    expect(writes.map((w) => w.table)).toEqual(["person"]);
    expect(Object.keys(writes[0].values).sort()).toEqual(["display_name", "profile_completed_at"]);
  });

  it("zero rows changed on person is a refusal, not a finish (the policy hid the row)", async () => {
    changed = { person: 0 };
    expect(await submit({ displayName: "Ann" })).toBe("/welcome?error=refused");
  });

  it("with no session, sends to the Sign in tab and writes nothing", async () => {
    user = null;
    // #234: the Sign in tab by name, a literal rather than SIGN_IN_URL so a wrong constant reddens here.
    expect(await submit({ displayName: "Ann" })).toBe("/join?mode=signin");
    expect(writes).toEqual([]);
  });
});
