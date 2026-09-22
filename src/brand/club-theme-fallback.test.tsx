import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ErrorReport } from "@/notify/error";
import { CLUB_THEME_READ_ERROR, CLUB_THEME_ROUTE, DEFAULT_CLUB_THEME, clubThemeFailureReport, themeFromRead } from "./club-theme-read";
import { HOOVER_SAILING_CLUB } from "./theme";

/**
 * Story #198 — a refused read of the club row paints the default theme and is reported, instead of
 * failing the page.
 *
 * The second half of this file renders the REAL root layout over the REAL loader
 * (`src/brand/club-theme.ts`), with only its I/O replaced: the service-role client answers every
 * read of `club` with the refusal production saw on 2026-09-22 (`JWT issued at future`), `after()`
 * collects its callbacks instead of running them after a response, and the reporter records what
 * it is handed instead of emailing. The loader imports `server-only`, which does not resolve
 * outside Next (#41's import death), so that module is mocked empty; everything the loader DECIDES
 * is the shipped code.
 *
 * The positive control is a readable row whose pair is NOT the default — so a loader that painted
 * the default on every read, success included, goes red here rather than passing as a fallback.
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

/** What the fake service-role client answers for `club`. */
type Answer =
  | { kind: "row"; row: { name: string; brand_disc: string; brand_mark: string } }
  | { kind: "refused"; message: string }
  | { kind: "throws"; message: string }
  | { kind: "empty" };
let answer: Answer = { kind: "refused", message: "JWT issued at future" };
let clubReads = 0;
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== "club") throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        limit: () => chain,
        async maybeSingle() {
          clubReads++;
          if (answer.kind === "throws") throw new TypeError(answer.message);
          if (answer.kind === "refused") return { data: null, error: { message: answer.message } };
          if (answer.kind === "empty") return { data: null, error: null };
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

async function renderPage(): Promise<string> {
  const { default: RootLayout } = await import("@/app/layout");
  return renderToStaticMarkup(await RootLayout({ children: <main data-the-page /> }));
}

beforeEach(() => {
  afterQueue.length = 0;
  reported.length = 0;
  clubReads = 0;
  answer = { kind: "refused", message: "JWT issued at future" };
});

describe("themeFromRead — the rule (#198)", () => {
  it("a refused read yields the default theme and exactly one report, carrying the platform's message", () => {
    const seen: ErrorReport[] = [];
    const theme = themeFromRead({ data: null, error: { message: "JWT issued at future" } }, (r) => seen.push(r));
    expect(theme).toEqual(DEFAULT_CLUB_THEME);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe(CLUB_THEME_READ_ERROR);
    expect(seen[0].message).toContain("JWT issued at future");
    expect(seen[0].routePath).toBe(CLUB_THEME_ROUTE);
  });

  it("a row is the theme, and nothing is reported", () => {
    const seen: ErrorReport[] = [];
    const theme = themeFromRead({ data: { name: "Anywhere YC", brand_disc: "#123456", brand_mark: "#FEDCBA" }, error: null }, (r) => seen.push(r));
    expect(theme).toEqual({ name: "Anywhere YC", disc: "#123456", mark: "#FEDCBA" });
    expect(seen).toEqual([]);
  });

  it("a MISSING row still throws, with the runbook step — that is configuration, not a refusal", () => {
    const seen: ErrorReport[] = [];
    expect(() => themeFromRead({ data: null, error: null }, (r) => seen.push(r))).toThrow(/not seeded — README, owner runbook step 1/);
    expect(seen).toEqual([]);
  });

  it("the default is the seed pair — what README's runbook writes into the row", () => {
    expect({ disc: DEFAULT_CLUB_THEME.disc, mark: DEFAULT_CLUB_THEME.mark }).toEqual(HOOVER_SAILING_CLUB);
  });

  it("the report tells the owner the page did NOT fail, and which pair it wore instead", () => {
    const r = clubThemeFailureReport("JWT issued at future");
    expect(r.message).toMatch(/painted in the default theme \(#395FAC \/ #FCCF0B\) instead of failing/);
    expect(r.digest).toBeNull();
  });
});

describe("the page renders when the club read always fails (#198 AC 1, AC 2)", () => {
  it("the root layout renders in the default theme instead of throwing", async () => {
    const html = await renderPage();
    expect(clubReads, "the real loader ran against the failing client").toBeGreaterThan(0);
    expect(html).toMatch(/<html lang="en" style="--brand-disc:#395FAC;--brand-mark:#FCCF0B;/);
    expect(html).toContain("data-the-page");
    expect(html).toMatch(/<title>Hoover Sailing Club<\/title>/);
  });

  it("the refusal is still reported — after the response, not during it", async () => {
    await renderPage();
    // Nothing is sent while the page renders: the report waits in after()'s queue.
    expect(reported).toEqual([]);
    expect(afterQueue.length).toBeGreaterThan(0);
    await drainAfter();
    expect(reported.length).toBeGreaterThan(0);
    for (const r of reported) {
      expect(r.name).toBe(CLUB_THEME_READ_ERROR);
      expect(r.message).toContain("JWT issued at future");
    }
  });

  it("the browser tab gets the default disc too, from the same loader", async () => {
    const { generateViewport } = await import("@/app/layout");
    expect((await generateViewport()).themeColor).toBe(DEFAULT_CLUB_THEME.disc);
    await drainAfter();
    expect(reported.length).toBeGreaterThan(0);
  });

  it("a query that THROWS instead of answering an error is the same refusal", async () => {
    answer = { kind: "throws", message: "fetch failed" };
    const html = await renderPage();
    expect(html).toMatch(/--brand-disc:#395FAC;--brand-mark:#FCCF0B;/);
    await drainAfter();
    expect(reported.map((r) => r.message).join("\n")).toContain("fetch failed");
  });

  it("positive control: a readable row paints the ROW's pair, and nothing is reported", async () => {
    answer = { kind: "row", row: { name: "Anywhere Yacht Club", brand_disc: "#123456", brand_mark: "#FEDCBA" } };
    const html = await renderPage();
    expect(html).toMatch(/<html lang="en" style="--brand-disc:#123456;--brand-mark:#FEDCBA;/);
    await drainAfter();
    expect(reported).toEqual([]);
  });

  it("a missing row still fails the page", async () => {
    answer = { kind: "empty" };
    await expect(renderPage()).rejects.toThrow(/not seeded/);
    await drainAfter();
    expect(reported).toEqual([]);
  });
});
