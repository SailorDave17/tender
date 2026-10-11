import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErrorReport } from "@/notify/error";
import { CLUB_THEME_READ_ERROR } from "@/brand/club-theme-read";
import { SUPPORT_ADDRESS_READ_ERROR, SUPPORT_ADDRESS_ROUTE, contactFromRead, supportAddressFailureReport } from "./contact-read";

/**
 * Story #204 — a refused read of `club.admin_email` renders /support with a sentence saying so,
 * and is reported, instead of failing the page.
 *
 * The second half of this file renders the REAL /support page inside the REAL root layout, over
 * the REAL loaders (`src/support/contact.ts` and `src/brand/club-theme.ts`), with only their I/O
 * replaced: the service-role client answers every read of `club` with the refusal production saw
 * on 2026-09-22 (`JWT issued at future`), `after()` collects its callbacks instead of running them
 * after a response, and the reporter records what it is handed instead of emailing. Both loaders
 * import `server-only`, which does not resolve outside Next (#41's import death), so that module
 * is mocked empty; everything the loaders DECIDE is the shipped code. Same arrangement as
 * `src/brand/club-theme-fallback.test.tsx`, which this story's layout half rests on.
 *
 * Every read of `club` fails at once, rather than only this story's, because that is the shape a
 * platform refusal takes in production: one request, two service-role reads of the same row. The
 * page has to survive both, and #198's probe measured /support failing on exactly that.
 *
 * The positive control is a readable row whose address is nobody's fixture — so a loader that
 * wrote the refusal sentence on every read, success included, goes red here.
 */

vi.mock("server-only", () => ({}));

const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
  after: (task: () => unknown) => {
    afterQueue.push(task);
  },
}));

const ROW = { name: "Anywhere Yacht Club", brand_disc: "#123456", brand_mark: "#FEDCBA", admin_email: "someone@club.example.test" };

/** What the fake service-role client answers for `club`, whichever columns are asked for. */
type Answer =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "refused"; message: string }
  | { kind: "throws"; message: string };
let answer: Answer = { kind: "refused", message: "JWT issued at future" };
/** Which column lists were asked for, in order — so a test can prove the address read ran. */
const selects: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== "club") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: (cols: string) => {
          selects.push(cols);
          return chain;
        },
        limit: () => chain,
        async maybeSingle() {
          if (answer.kind === "throws") throw new TypeError(answer.message);
          if (answer.kind === "refused") return { data: null, error: { message: answer.message } };
          return { data: answer.row, error: null };
        },
      };
      return chain;
    },
  }),
}));

const reported: ErrorReport[] = [];
vi.mock("@/notify/error-live", () => ({
  reportErrorLive: async (r: ErrorReport) => {
    reported.push(r);
    return null;
  },
}));

vi.mock("@/shell/session", () => ({ currentPerson: async () => null }));

/** Run what `after()` was handed, the way Next does once the response has gone. */
async function drainAfter(): Promise<void> {
  while (afterQueue.length) await afterQueue.shift()!();
}

/** /support as a signed-out visitor gets it: the page inside the root layout. */
async function renderSupport(): Promise<string> {
  const { default: RootLayout } = await import("@/app/layout");
  const { default: SupportPage } = await import("@/app/support/page");
  return renderToStaticMarkup(await RootLayout({ children: await SupportPage() }));
}

/** The address read, as distinct from the theme's read of the same row. */
const addressReads = () => selects.filter((c) => c === "admin_email").length;

beforeEach(() => {
  afterQueue.length = 0;
  reported.length = 0;
  selects.length = 0;
  answer = { kind: "refused", message: "JWT issued at future" };
});

describe("contactFromRead — the rule (#204)", () => {
  it("a refused read is its own state, with exactly one report carrying the platform's message", () => {
    const seen: ErrorReport[] = [];
    const contact = contactFromRead({ data: null, error: { message: "JWT issued at future" } }, (r) => seen.push(r));
    expect(contact).toEqual({ kind: "unreadable" });
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe(SUPPORT_ADDRESS_READ_ERROR);
    expect(seen[0].message).toContain("JWT issued at future");
    expect(seen[0].routePath).toBe(SUPPORT_ADDRESS_ROUTE);
  });

  it("an address is the contact, trimmed, and nothing is reported", () => {
    const seen: ErrorReport[] = [];
    expect(contactFromRead({ data: { admin_email: "  someone@club.example.test " }, error: null }, (r) => seen.push(r))).toEqual({
      kind: "address",
      address: "someone@club.example.test",
    });
    expect(seen).toEqual([]);
  });

  it("a null or blank column, or no row, is `none` — a state the club chose, not a refusal — and nothing is reported", () => {
    const seen: ErrorReport[] = [];
    for (const data of [{ admin_email: null }, { admin_email: "   " }, null]) {
      expect(contactFromRead({ data, error: null }, (r) => seen.push(r)), JSON.stringify(data)).toEqual({ kind: "none" });
    }
    expect(seen).toEqual([]);
  });

  it("the report says the page did NOT fail, and carries no query string", () => {
    const r = supportAddressFailureReport("JWT issued at future");
    expect(r.message).toMatch(/\/support rendered and told the reader to reload, instead of failing/);
    expect(r.path).toBe("/support");
    expect(r.digest).toBeNull();
  });
});

describe("/support renders when every read of the club row fails (#204 AC 1, AC 2)", () => {
  it("the page renders inside the layout, saying the address could not be loaded — not the error boundary", async () => {
    const html = await renderSupport();
    expect(addressReads(), "the real address loader ran against the failing client").toBe(1);
    expect(html).toContain('<main data-page="support">');
    expect(html).toContain('data-contact="unreadable"');
    expect(html).toContain("could not be loaded just now");
    // not the null state's sentence, which would tell the reader the club has no address
    expect(html).not.toContain('data-contact="none"');
    expect(html).not.toContain("has not given Tender a contact address");
    expect(html).not.toContain("mailto:");
    // the rest of the page is still there for them: the known issues and the privacy link
    expect(html).toContain("<ul data-known-issues");
    expect(html).toContain('href="/privacy"');
  });

  it("the refusal is still reported — after the response, not during it", async () => {
    await renderSupport();
    expect(reported).toEqual([]);
    await drainAfter();
    const mine = reported.filter((r) => r.name === SUPPORT_ADDRESS_READ_ERROR);
    expect(mine).toHaveLength(1);
    expect(mine[0].message).toContain("JWT issued at future");
    // and the theme's own report beside it: two reads failed, two things are said
    expect(reported.map((r) => r.name)).toContain(CLUB_THEME_READ_ERROR);
  });

  it("a query that THROWS instead of answering an error is the same refusal", async () => {
    answer = { kind: "throws", message: "fetch failed" };
    const html = await renderSupport();
    expect(html).toContain('data-contact="unreadable"');
    await drainAfter();
    expect(reported.filter((r) => r.name === SUPPORT_ADDRESS_READ_ERROR).map((r) => r.message).join("\n")).toContain("fetch failed");
  });

  it("positive control: a readable row names the ROW's address, and nothing is reported", async () => {
    answer = { kind: "row", row: ROW };
    const html = await renderSupport();
    expect(html).toContain('<a href="mailto:someone@club.example.test">someone@club.example.test</a>');
    expect(html).not.toContain('data-contact="unreadable"');
    await drainAfter();
    expect(reported).toEqual([]);
  });

  it("a row with no address still says who to ask, and reports nothing", async () => {
    answer = { kind: "row", row: { ...ROW, admin_email: null } };
    const html = await renderSupport();
    expect(html).toContain('data-contact="none"');
    expect(html).not.toContain('data-contact="unreadable"');
    await drainAfter();
    expect(reported).toEqual([]);
  });
});
