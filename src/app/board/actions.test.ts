import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story #214 AC 6 and AC 7: where the board's Server Action sends a member, driven in-process
 * with the cookie-bound client faked (#123's instrument; welcome/actions.test.ts is the model).
 *
 * AC 6: a toggle pressed in the full-season view comes back to the full-season view at that
 *       date's anchor, on success and on every `?error=` branch, with the error kept.
 * AC 7: a `view` field that is not on the allow-list (an absolute URL, a `//host` value) is the
 *       default view, so the redirect is to /board and never to what the field said.
 *
 * Two things were added at the #214 review, and both are in the table below:
 * - The default view goes back to the date's row as well. Without the anchor a keyboard's next
 *   Tab started again from the first day (measured on the running board).
 * - A refusal names its row in the query (`on`), so the page can show the sentence inside the
 *   row the member is sent to. And where that row will not be on the page, the address has no
 *   fragment at all, so the member lands at the top beside the sentence: a date that is not
 *   published, an id that is no date, a date that has sailed out of the default view.
 *
 * That the anchor resolves to a row is page.test.tsx's (each day's `id`), and that a browser
 * follows it through a Server Action redirect is the smoke's (scripts/smoke.mjs).
 *
 * What is faked answers the same way for every case except the one knob the case turns, and
 * each case reaches its branch for the reason its name gives: `reached` records how far the
 * action got, so a refusal that came from an earlier branch than the one named fails here.
 */

class Redirect extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

const ME = "11111111-1111-4111-8111-111111111111";
const DAY = "22222222-2222-4222-8222-222222222222";
const FUTURE = "2999-06-06T17:00:00.000Z";
const SAILED = "2000-06-06T17:00:00.000Z";

type World = {
  user: { id: string } | null;
  me: { rating: number | null } | null;
  date: { starts_at: string } | null;
  insertError: { code: string } | null;
  deleteError: { code: string } | null;
  open: { id: string }[];
};
let world: World;
let reached: string[];
let revalidated: string[];
let notified: string[];

const client = {
  auth: { getUser: async () => ({ data: { user: world.user } }) },
  from: (table: string) => {
    const read = (row: unknown) => {
      const node: Record<string, unknown> = {
        eq: () => node,
        is: async () => ({ data: world.open }),
        maybeSingle: async () => {
          reached.push(`read ${table}`);
          return { data: row };
        },
      };
      return node;
    };
    return {
      select: () => read(table === "person" ? world.me : table === "race_date" ? world.date : null),
      insert: async () => {
        reached.push(`insert ${table}`);
        return { error: world.insertError };
      },
      delete: () => ({
        eq: () => ({
          eq: async () => {
            reached.push(`delete ${table}`);
            return { error: world.deleteError };
          },
        }),
      }),
    };
  },
};

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => client }));
vi.mock("@/notify/live", () => ({
  notifyRungLive: async (id: string) => {
    notified.push(id);
  },
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

const { setAvailability } = await import("./actions");

/** A member with a rating, a published date still to sail, one open post on it, nothing refused. */
function resetWorld() {
  world = { user: { id: ME }, me: { rating: 3 }, date: { starts_at: FUTURE }, insertError: null, deleteError: null, open: [{ id: "post-1" }] };
  reached = [];
  revalidated = [];
  notified = [];
}
beforeEach(resetWorld);

/** Run the action and return where it redirected. It always redirects, success or refusal. */
async function submit(fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  try {
    await setAvailability(form);
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
  throw new Error("setAvailability returned without redirecting");
}

type View = "season" | "default";
type Branch = {
  name: string;
  /** Turn the one knob that reaches this branch. */
  arrange?: () => void;
  fields?: Record<string, string>;
  /** The `?error=` value, or null on success. */
  error: string | null;
  /** The views in which the date's row is on the page the member returns to. */
  row: View[];
  /** How far the action got: the proof the redirect came from this branch and not an earlier one. */
  reaches: string[];
};

const READS = ["read person", "read race_date"];
const BOTH: View[] = ["season", "default"];
const BRANCHES: Branch[] = [
  { name: "a race_date_id that is not a UUID", fields: { race_date_id: "not-a-uuid" }, error: "refused", row: [], reaches: [] },
  { name: "a date that is not published, or not there", arrange: () => (world.date = null), error: "refused", row: [], reaches: READS },
  { name: "no person row", arrange: () => (world.me = null), error: "refused", row: BOTH, reaches: READS },
  { name: "a member with no rating", arrange: () => (world.me = { rating: null }), error: "no-rating", row: BOTH, reaches: READS },
  // A sailed date is listed by the full season and is outside the default view.
  { name: "a date already sailed", arrange: () => (world.date = { starts_at: SAILED }), error: "past", row: ["season"], reaches: READS },
  { name: "the insert refused by the database", arrange: () => (world.insertError = { code: "42501" }), error: "refused", row: BOTH, reaches: [...READS, "insert availability"] },
  {
    name: "the delete refused by the database",
    arrange: () => (world.deleteError = { code: "42501" }),
    fields: { available: "false" },
    error: "refused",
    row: BOTH,
    reaches: [...READS, "delete availability"],
  },
  { name: "marking a day", error: null, row: BOTH, reaches: [...READS, "insert availability"] },
  { name: "marking a day twice (23505)", arrange: () => (world.insertError = { code: "23505" }), error: null, row: BOTH, reaches: [...READS, "insert availability"] },
  { name: "unmarking a day", fields: { available: "false" }, error: null, row: BOTH, reaches: [...READS, "delete availability"] },
];

const run = (b: Branch, view?: string) => {
  b.arrange?.();
  return submit({ race_date_id: DAY, available: "true", ...b.fields, ...(view === undefined ? {} : { view }) });
};

/** The address a branch must produce, spelled out here rather than built by the code under test. */
function expected(b: Branch, view: View): string {
  const atRow = b.row.includes(view);
  const query = [view === "season" ? "view=season" : "", b.error ? `error=${b.error}` : "", b.error && atRow ? `on=${DAY}` : ""].filter(Boolean).join("&");
  return `/board${query ? `?${query}` : ""}${atRow ? `#${DAY}` : ""}`;
}

describe("from the full-season view, every way out comes back to it, at the date's anchor wherever the date is listed (#214 AC 6)", () => {
  it.each(BRANCHES)("$name", async (b) => {
    const to = await run(b, "season");
    expect(reached, "the action got as far as this branch and no further").toEqual(b.reaches);
    expect(to).toBe(expected(b, "season"));
    // Read back as a browser would: the view, the error, the row and the anchor are separate parts.
    const atRow = b.row.includes("season");
    const url = new URL(to, "https://tender.example");
    expect(url.pathname).toBe("/board");
    expect(url.searchParams.get("view")).toBe("season");
    expect(url.searchParams.get("error")).toBe(b.error);
    expect(url.searchParams.get("on")).toBe(b.error && atRow ? DAY : null);
    expect(url.hash).toBe(atRow ? `#${DAY}` : "");
  });

  it("the table spells the addresses AC 6 names", () => {
    // Control on `expected()` itself, so the table is not checking the code against a builder
    // that agrees with it by construction.
    const sailed = BRANCHES.find((b) => b.name === "a date already sailed")!;
    const marked = BRANCHES.find((b) => b.name === "marking a day")!;
    const noDate = BRANCHES.find((b) => b.name === "a date that is not published, or not there")!;
    expect(expected(sailed, "season")).toBe(`/board?view=season&error=past&on=${DAY}#${DAY}`);
    expect(expected(marked, "season")).toBe(`/board?view=season#${DAY}`);
    expect(expected(noDate, "season")).toBe("/board?view=season&error=refused");
    expect(expected(sailed, "default")).toBe("/board?error=past");
    expect(expected(marked, "default")).toBe(`/board#${DAY}`);
  });

  it("every redirect in the action goes through back(), and the table drives every one", () => {
    // Guards the table above against the file gaining a way out the table does not drive.
    const src = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
    const calls = [...src.matchAll(/\bredirect\(([^;]*)\);/g)].map((m) => m[1]);
    expect(calls).toEqual([
      'back("refused")',
      "SIGN_IN_URL",
      'back("refused")',
      'back("refused", row)',
      "back(refusal, row)",
      'back("refused", row)',
      'back("refused", row)',
      "back(undefined, row)",
    ]);
    // `row` is decided once, by the rule the page lists dates with.
    expect(src).toMatch(/const row = showsDate\(view, date\.starts_at, now\) \? raceDateId : undefined;/);
    // No address is spelled in the action itself, so none can skip the view.
    expect(src).not.toMatch(/["'`]\/board/);
  });
});

describe("from the default view, every way out comes back to the date's row too, except a date outside the view", () => {
  it.each(BRANCHES)("$name", async (b) => {
    const to = await run(b);
    expect(reached).toEqual(b.reaches);
    expect(to).toBe(expected(b, "default"));
    expect(new URL(to, "https://tender.example").searchParams.has("view"), "the default view is never named in its own address").toBe(false);
  });

  it("a refusal for a date that has sailed lands at the top of the default view, with no fragment", async () => {
    // The row is not in the default view, so an anchor would point at nothing and the browser
    // would leave the member where they were, away from the sentence above the list.
    world.date = { starts_at: SAILED };
    expect(await submit({ race_date_id: DAY, available: "true" })).toBe("/board?error=past");
  });

  it("naming the default view in the field changes nothing", async () => {
    expect(await submit({ race_date_id: DAY, available: "true", view: "upcoming" })).toBe(`/board#${DAY}`);
  });
});

describe("a view that is not on the allow-list goes to the default /board (#214 AC 7)", () => {
  const HOSTILE = [
    "https://evil.example/board",
    "//evil.example",
    "//evil.example/board?view=season",
    "/\\evil.example",
    "http:evil.example",
    "javascript:alert(1)",
    "season/../../join",
    "season?next=//evil.example",
    "season#x",
    "/board?view=season",
    "SEASON",
    " season",
    "",
  ];
  const success = BRANCHES.find((b) => b.name === "marking a day")!;
  const refusal = BRANCHES.find((b) => b.name === "a date already sailed")!;
  const notUuid = BRANCHES.find((b) => b.name === "a race_date_id that is not a UUID")!;

  it.each(HOSTILE.map((v) => [JSON.stringify(v), v]))("view=%s", async (_shown, view) => {
    for (const b of [success, refusal, notUuid]) {
      // Each run starts from the same world; `arrange` turns one knob.
      resetWorld();
      const to = await run(b, view);
      expect(to, `${b.name}: exactly the default view's target`).toBe(expected(b, "default"));
      const url = new URL(to, "https://tender.example");
      expect(url.origin, `${b.name}: the redirect stays on this origin`).toBe("https://tender.example");
      expect(url.pathname).toBe("/board");
      expect(url.searchParams.has("view"), `${b.name}: no view is carried`).toBe(false);
      expect(to).not.toContain("evil");
    }
  });

  it("control: the same three branches with the allowed view do carry it", async () => {
    // Without this, a boardView() that refused everything would pass every case above.
    expect(await run(success, "season")).toBe(`/board?view=season#${DAY}`);
    resetWorld();
    expect(await run(refusal, "season")).toBe(`/board?view=season&error=past&on=${DAY}#${DAY}`);
    resetWorld();
    expect(await run(notUuid, "season")).toBe("/board?view=season&error=refused");
  });
});

describe("what the action still does around the redirect", () => {
  it("a signed-out caller goes to sign-in, whatever view the form named", async () => {
    world.user = null;
    const to = await submit({ race_date_id: DAY, available: "true", view: "season" });
    expect(to.startsWith("/join")).toBe(true);
    expect(to).not.toContain("view=season");
  });

  it("a success revalidates /board and re-evaluates the day's open posts; a refusal does neither", async () => {
    await submit({ race_date_id: DAY, available: "true", view: "season" });
    expect(revalidated).toEqual(["/board"]);
    expect(notified).toEqual(["post-1"]);
    revalidated = [];
    notified = [];
    world.date = { starts_at: SAILED };
    await submit({ race_date_id: DAY, available: "true", view: "season" });
    expect(revalidated).toEqual([]);
    expect(notified).toEqual([]);
  });
});
