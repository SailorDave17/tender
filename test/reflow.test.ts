import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { fitGoogleButton } from "@/auth/GoogleButton";
import { InstallBannerView } from "@/install/InstallBanner";
import { installAdvice } from "@/install/prompt";
import { watchSheet } from "@/install/sheet";
import { watchDock } from "@/shell/dock";
import type { ShellPerson } from "@/shell/session";
import { CHROME_CLOSE_TIMEOUT_MS, closeChrome } from "./chrome";
import { GLOBALS_CSS } from "./tokens";
import { AVAILABILITY, IDS, MATCHES, ME, NOW, PEOPLE, POSTS, RACE_DATES, TABLES, fakeClient, uuid, type Tables } from "./surfaces";

/**
 * Story #251 — every screen fits any width, text size and zoom without sideways scrolling (WCAG
 * 1.4.4 resize text, 1.4.10 reflow, 2.4.11 focus not obscured).
 *
 * EVERY PAGE ROUTE ON DISK, rendered as `test/surfaces.test.ts` renders its nine: the real Server
 * Component through the real root layout, the real stylesheet inlined, read in the machine's Chrome
 * (`playwright-core`, `channel: "chrome"`). What is faked is the database (`test/surfaces.ts`'s
 * world, grown here to reach the admin screens), the session, the club row and the Server Actions,
 * none of which lay anything out. `RENDERS` is held equal to the `page.tsx` files under `src/app`,
 * so a new route with no row reddens the first test below.
 *
 * Three readings, one `it` per render for each, so a fix's removal reddens exactly the screens it
 * holds up:
 *
 *   AC 1  at 320, 360, 390, 768, 1280 and 1920px wide, `documentElement.scrollWidth` equals
 *         `clientWidth`. A failure names the innermost boxes past the right edge.
 *   AC 2  at 200% text on 320 and 390px, the same, and no element carrying text is wider inside
 *         than its own box (`scrollWidth > clientWidth`), except inside a container that scrolls
 *         sideways on purpose, which says so with `data-scroll-x`.
 *   AC 3  at 400% zoom on a 1280 × 1024 window, which Chrome lays out as a 320 × 256 CSS-pixel
 *         viewport, every focusable control in `<main>` is reached by a real Tab press, and the
 *         element at the centre of what Tab scrolled into view is the control itself: not the
 *         docked nav, the install sheet or the header.
 *
 * WHICH 200% THIS IS. The issue reasoned that a `rem` in a media query follows the browser's
 * default font size and not the page's root font size. *Measured 2026-10-11, Chrome 154*: it does.
 * `documentElement.style.fontSize = "200%"` (what `test/join-reflow.test.ts` sets) doubles every
 * rem in the page and leaves `(max-width: 39.99rem)` at 640px; the browser's own default font size
 * (Chrome's Settings → Appearance → Font size, set here over CDP as `Page.setFontSizes`) doubles
 * both, so at 32px the nav docks on any window under 1280px. AC 2 uses the browser's setting,
 * because that is the one a member has. The test at the end holds the difference.
 *
 * Hydration's layout effects are run by hand, as `test/install-sheet.test.ts` runs them: the real
 * `watchDock` on every signed-in page (the docked nav is 104px at 320px with the Admin link, not
 * the stylesheet's 56px fallback), Google's button through the real `fitGoogleButton` on a stand-in
 * GIS, and on one /board render the install sheet's real markup with the real `watchSheet`.
 *
 * WHAT THIS CANNOT SEE: a phone's own fonts (CI's Linux fonts are wider than this machine's, which
 * is why AC 2 is at 200%, where an overrun shows on any fonts); Android Chrome's text scaling, which
 * is not the desktop default font size; anything only a client effect renders apart from the three
 * above; and pinch zoom, which magnifies without reflowing (the issue's out of scope).
 */

const holder = vi.hoisted(() => ({ client: null as unknown, person: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => holder.client }));
vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({ currentPerson: async () => holder.person }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/support/contact", () => ({ loadSupportAddress: async () => ({ kind: "address", address: "someone@club.example.test" }) }));
// Every Server Action module a page imports. None paints anything; a form renders its action as a
// placeholder whatever the function is.
vi.mock("@/app/board/actions", () => ({ setAvailability: async () => undefined }));
vi.mock("@/app/post/actions", () => ({
  acceptAnswer: async () => undefined,
  answerPost: async () => undefined,
  closePost: async () => undefined,
  setMatchStatus: async () => undefined,
  createPost: async () => undefined,
}));
vi.mock("@/app/boats/actions", () => ({ createBoat: async () => undefined }));
vi.mock("@/app/profile/actions", () => ({ saveProfile: async () => undefined }));
vi.mock("@/app/profile/account-actions", () => ({ deleteMyAccount: async () => undefined }));
vi.mock("@/app/admin/actions", () => ({ rotateInviteCode: async () => undefined }));
vi.mock("@/app/admin/dates/actions", () => ({ createRaceDate: async () => undefined, setPublished: async () => undefined }));
vi.mock("@/app/admin/dates/import/actions", () => ({ publishSelected: async () => undefined }));
vi.mock("@/app/admin/dates/import/upload", () => ({ readIcs: async () => null }));
vi.mock("@/app/admin/invite/actions", () => ({ sendInvitesAction: async () => undefined }));
vi.mock("@/app/admin/people/actions", () => ({ suspendPerson: async () => undefined, liftSuspension: async () => undefined }));
vi.mock("@/app/admin/theme/actions", () => ({ setClubTheme: async () => undefined }));
vi.mock("@/app/admin/threads/actions", () => ({ removeMessage: async () => undefined }));
vi.mock("@/app/post/[id]/thread/actions", () => ({ sendMessage: async () => undefined }));
vi.mock("@/app/welcome/actions", () => ({ finishProfile: async () => undefined }));
vi.mock("@/app/reset-password/actions", () => ({ setNewPassword: async () => undefined }));

const css = readFileSync(GLOBALS_CSS, "utf8");
const APP = fileURLToPath(new URL("../src/app/", import.meta.url)).replace(/[\\/]$/, "");

// ---- the world ----------------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

/** The race days re-keyed to UUIDs: /admin/dates/[id] refuses any other id before it reads. */
const DATE_ID: Record<string, string> = { "d-past": uuid(31), "d-next": uuid(32), "d-later": uuid(33) };
const dated = <T extends { race_date_id: string }>(rows: T[]) => rows.map((r) => ({ ...r, race_date_id: DATE_ID[r.race_date_id] }));
const DATES = RACE_DATES.map((d) => ({ ...d, id: DATE_ID[d.id] }));
const NEXT = DATES[1];
const MATCH = MATCHES[0];

const WORLD: Tables = {
  ...TABLES,
  race_date: [...DATES, { id: uuid(34), starts_at: at(19), title: "Sunday series 4", published: false }],
  post: dated(POSTS),
  availability: dated(AVAILABILITY),
  // Ada is the club's admin, so every page she signs in to carries the Admin link, and the docked
  // nav wraps to two rows at 320px: the tallest dock a member sees (#217's measurement).
  person: PEOPLE.map((p) => ({ ...p, is_admin: p.id === ME })),
  // The thread screens embed the post's boat and race day in the match read.
  match: MATCHES.map((m) => ({ ...m, post: { boat: { name: "Wanderer", class: "Flying Scot" }, race_date: { starts_at: NEXT.starts_at, title: NEXT.title } } })),
  message: [
    // A pasted link is the longest unbroken word a member writes.
    {
      id: uuid(41),
      match_id: MATCH.id,
      author_id: "p-ann",
      body: "We launch from the north ramp at noon. The forecast I go by: https://www.windfinder.com/forecast/hoover_reservoir_westerville",
      created_at: at(-1),
      removed_at: null,
    },
    { id: uuid(42), match_id: MATCH.id, author_id: "p-cy", body: "See you there. I will bring my own PFD.", created_at: at(-0.9), removed_at: null },
    { id: uuid(43), match_id: MATCH.id, author_id: "p-cy", body: "Removed by the club admin", created_at: at(-0.8), removed_at: at(-0.5) },
  ],
  message_removal: [{ message_id: uuid(43), body: "Something the admin took down." }],
  // A plus-alias at the club's domain: the longest address a matched crew's panel is likely to show.
  person_contact: [{ person_id: "p-cy", email: "cy.twombly+tender@hooversailingclub.example.org", phone: "614-555-0100" }],
  club: [{ brand_disc: "#395FAC", brand_mark: "#FCCF0B" }],
  tick_run: [{ last_at: at(-0.01), sweep_at: at(-0.2) }],
};

const RPCS = {
  current_invite_code: "K7QX4M2P",
  // Amber on the day, so the warning sentence renders as well as the figures.
  email_usage: [{ day_count: 74, month_count: 1460 }],
  push_install_status: [
    { person_id: ME, devices: 1 },
    { person_id: "p-cy", devices: 2 },
  ],
};

/** A send's report as the action puts it in the URL: the longest addresses an admin pastes. */
const REPORT = Buffer.from(
  JSON.stringify({
    sent: ["margaret.featherstonehaugh+tender@yahoo.com", "commodore@hooversailingclub.example.org"],
    refused: [{ email: "j.smith@exampel.test", error: "The domain exampel.test does not accept mail" }],
    members: ["ada@example.test"],
    malformed: ["call me on 614-555-0100"],
    duplicates: [],
  }),
).toString("base64url");

const ADA: ShellPerson = { id: ME, email: "ada@example.test", displayName: "Ada Lovelace", isAdmin: true };
const CY: ShellPerson = { id: "p-cy", email: "cy@example.test", displayName: "Cy Twombly", isAdmin: false };
const NEWCOMER: ShellPerson = { id: "p-new", email: "newcomer@example.test", displayName: null, isAdmin: false };
const GOOGLE = { NEXT_PUBLIC_GOOGLE_CLIENT_ID: "000000000000-reflow.apps.googleusercontent.com" };

// ---- the renders ----------------------------------------------------------------------------------

type Render = {
  /** The route as its directory spells it, `/post/[id]/thread`. */
  route: string;
  /** What this render shows, where a route has more than one. */
  variant?: string;
  /** Who the shell says is signed in; null renders the signed-out shell. */
  person: ShellPerson | null;
  /** The user the page's own client reads as, where it is not the shell's person. */
  as?: string;
  tables?: Tables;
  env?: Record<string, string>;
  /** A client effect run in the page after load, as hydration would. */
  hydrate?: "google" | "install-sheet";
  render: () => Promise<ReactNode>;
};

const sp = <T,>(v: T) => Promise.resolve(v);

const RENDERS: Render[] = [
  { route: "/", person: null, render: async () => (await import("@/app/page")).default({ searchParams: sp({}) }) },
  { route: "/admin", person: ADA, render: async () => (await import("@/app/admin/page")).default({ searchParams: sp({}) }) },
  { route: "/admin/dates", person: ADA, render: async () => (await import("@/app/admin/dates/page")).default({ searchParams: sp({}) }) },
  { route: "/admin/dates/[id]", person: ADA, render: async () => (await import("@/app/admin/dates/[id]/page")).default({ params: sp({ id: NEXT.id }) }) },
  { route: "/admin/dates/import", person: ADA, render: async () => (await import("@/app/admin/dates/import/page")).default({ searchParams: sp({}) }) },
  { route: "/admin/invite", person: ADA, render: async () => (await import("@/app/admin/invite/page")).default({ searchParams: sp({}) }) },
  {
    route: "/admin/invite",
    variant: "a send's report",
    person: ADA,
    render: async () => (await import("@/app/admin/invite/page")).default({ searchParams: sp({ report: REPORT }) }),
  },
  {
    route: "/admin/people",
    person: ADA,
    // One suspension, so the Lift control and its date render. Kept out of WORLD: the fake ignores
    // `eq`, so every page reading the caller's own suspension would read this row as theirs.
    tables: { ...WORLD, suspension: [{ person_id: "p-ann", suspended_at: at(-3) }] },
    render: async () => (await import("@/app/admin/people/page")).default({ searchParams: sp({}) }),
  },
  { route: "/admin/theme", person: ADA, render: async () => (await import("@/app/admin/theme/page")).default({ searchParams: sp({}) }) },
  { route: "/admin/threads", person: ADA, render: async () => (await import("@/app/admin/threads/page")).default() },
  {
    route: "/admin/threads/[id]",
    person: ADA,
    render: async () => (await import("@/app/admin/threads/[id]/page")).default({ params: sp({ id: MATCH.id }), searchParams: sp({}) }),
  },
  { route: "/board", person: ADA, render: async () => (await import("@/app/board/page")).default({ searchParams: sp({}) }) },
  {
    route: "/board",
    variant: "the install sheet up",
    person: ADA,
    hydrate: "install-sheet",
    render: async () => (await import("@/app/board/page")).default({ searchParams: sp({}) }),
  },
  { route: "/boats", person: ADA, render: async () => (await import("@/app/boats/page")).default({ searchParams: sp({}) }) },
  { route: "/forgot", person: null, render: async () => (await import("@/app/forgot/page")).default() },
  ...(["signup", "signin"] as const).flatMap((mode): Render[] => {
    const tab = mode === "signup" ? "Sign up" : "Sign in";
    const join = async () => (await import("@/app/join/page")).default({ searchParams: sp({ mode }) });
    return [
      { route: "/join", variant: tab, person: null, render: join },
      { route: "/join", variant: `${tab}, Google on`, person: null, env: GOOGLE, hydrate: "google", render: join },
    ];
  }),
  {
    route: "/post/[id]",
    variant: "the skipper's open post",
    person: ADA,
    render: async () => (await import("@/app/post/[id]/page")).default({ params: sp({ id: IDS.postOpen }), searchParams: sp({}) }),
  },
  {
    route: "/post/[id]",
    variant: "the crew's match",
    person: CY,
    render: async () => (await import("@/app/post/[id]/page")).default({ params: sp({ id: IDS.postCrewed }), searchParams: sp({}) }),
  },
  { route: "/post/[id]/thread", person: CY, render: async () => (await import("@/app/post/[id]/thread/page")).default({ params: sp({ id: IDS.postCrewed }) }) },
  { route: "/post/new", person: ADA, render: async () => (await import("@/app/post/new/page")).default({ searchParams: sp({ boat: IDS.boatMoon }) }) },
  { route: "/privacy", person: null, render: async () => (await import("@/app/privacy/page")).default() },
  { route: "/profile", person: ADA, render: async () => (await import("@/app/profile/page")).default({ searchParams: sp({}) }) },
  {
    route: "/profile/[id]",
    person: CY,
    // The fake hands `maybeSingle` the caller's own row first; a reader not in the table gets Ada's,
    // so this is another member's profile as Cy would open it.
    as: "p-viewer",
    render: async () => (await import("@/app/profile/[id]/page")).default({ params: sp({ id: uuid(51) }) }),
  },
  { route: "/reset-password", person: CY, render: async () => (await import("@/app/reset-password/page")).default({ searchParams: sp({}) }) },
  { route: "/support", person: null, render: async () => (await import("@/app/support/page")).default() },
  { route: "/welcome", person: NEWCOMER, render: async () => (await import("@/app/welcome/page")).default({ searchParams: sp({}) }) },
];

const nameOf = (r: Render) => (r.variant ? `${r.route} (${r.variant})` : r.route);

/** Every `page.tsx` under src/app as its route, a route group's `(name)` segment dropped. */
function routesOnDisk(dir = APP, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) return routesOnDisk(p, /^\(.*\)$/.test(name) ? prefix : `${prefix}/${name}`);
    return name === "page.tsx" ? [prefix || "/"] : [];
  });
}

// ---- rendering and opening ------------------------------------------------------------------------

const docs = new Map<string, string>();
const renderErrors = new Map<string, string>();
const sheetMarkup = renderToStaticMarkup(
  createElement(InstallBannerView, {
    // The iOS wording, the longer of the two the decision returns.
    advice: installAdvice({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1",
      standalone: false,
      dismissed: false,
      promptAvailable: false,
      maxTouchPoints: 5,
    }),
  }),
);
let browser: Browser;

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    const { default: RootLayout } = await import("@/app/layout");
    for (const r of RENDERS) {
      holder.client = fakeClient(r.as ?? r.person?.id ?? "", r.tables ?? WORLD, RPCS);
      holder.person = r.person;
      for (const [k, v] of Object.entries(r.env ?? {})) vi.stubEnv(k, v);
      try {
        const doc = renderToStaticMarkup(await RootLayout({ children: await r.render() }));
        docs.set(nameOf(r), `<!doctype html>${doc.replace("<body>", `<head><style>${css}</style></head><body>`)}`);
      } catch (e) {
        renderErrors.set(nameOf(r), e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
      } finally {
        vi.unstubAllEnvs();
      }
    }
  } finally {
    vi.useRealTimers();
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  await closeChrome(browser);
}, CHROME_CLOSE_TIMEOUT_MS);

const FRAMES = `const frames = (n) => new Promise((done) => { const step = () => (n-- ? requestAnimationFrame(step) : done()); step(); });`;
const settle = (page: Page) => page.evaluate(`(async () => { ${FRAMES} await frames(2); })()`);

/** A short name for an element in a failure message: its tag, first hooks and text. */
const LABEL = `
  const label = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const hooks = [...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "id").slice(0, 2).map((a) => "[" + a.name + "]").join("");
    return el.tagName.toLowerCase() + hooks + " " + JSON.stringify((el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 28));
  };
  const innermost = (els) => els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
`;

/**
 * CI's fonts are wider than this machine's: #217's sheet passed here and failed three times on the
 * runner, each time on a fit that Segoe UI made and the runner's fonts did not. So AC 2 reads every
 * page twice, once in the app's own `system-ui` and once with the body font forced to Verdana, which
 * is about as wide as the DejaVu Sans a Linux runner falls back to (and on the runner, where there
 * is no Verdana, it is that fallback). *Measured 2026-10-11*: Verdana found the rung badge 10px past
 * a 320px phone at 200% text, which Segoe UI fitted.
 */
const WIDE_FONT = "Verdana, sans-serif";
const FONT_BODY = "--font-body: system-ui, sans-serif;";

function withFont(sheet: string, font: string): string {
  if (sheet.split(FONT_BODY).length !== 2) throw new Error(`expected exactly one "${FONT_BODY}" in globals.css`);
  return sheet.replace(FONT_BODY, `--font-body: ${font};`);
}

type Open = {
  viewport: { width: number; height: number };
  /** The browser's default font size as a multiple of its 16px (Chrome's own setting). */
  text?: number;
  /** The device pixels per CSS pixel: 4 is a 400% zoom on a 1x screen. */
  scale?: number;
  /** The body font, in place of the app's `system-ui`. */
  font?: string;
};

/**
 * One page per pixel ratio for the whole file, sent to `about:blank` before each reading, so the
 * file starts two renderer processes rather than the ~190 a page per reading did. Each reading
 * still gets a new document, its own viewport and its own font size (set every time, 16px included,
 * because CDP's font sizes outlive a navigation); AC 1 asserts the 16px.
 *
 * *Measured 2026-10-11 in the owner's checkout* (#280's local-only close timeout, ~60 other Chrome
 * processes and a Taskr stack running): with a page per reading this file's own `browser.close()`
 * passed #247's 180 s in 7 of 7 full runs. With one page it did so in 0 of 3, and the file alone
 * went from 35 s to 19 s. Other Chrome files' closes still timed out in each of those three runs,
 * against 2 of 6 runs without this file at all, so it still adds to #280. It did not cause #280.
 */
const tabs = new Map<number, Promise<{ page: Page; cdp: CDPSession }>>();
const tabFor = (scale: number) => {
  if (!tabs.has(scale))
    tabs.set(
      scale,
      (async () => {
        const context: BrowserContext = await browser.newContext({ deviceScaleFactor: scale });
        const page = await context.newPage();
        return { page, cdp: await context.newCDPSession(page) };
      })(),
    );
  return tabs.get(scale)!;
};

async function open(r: Render, o: Open) {
  const doc = docs.get(nameOf(r));
  if (!doc) throw new Error(`${nameOf(r)} did not render:\n${renderErrors.get(nameOf(r))}`);
  const { page, cdp } = await tabFor(o.scale ?? 1);
  await page.goto("about:blank");
  await page.setViewportSize(o.viewport);
  const text = o.text ?? 1;
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 16 * text, fixed: 13 * text } });
  // The function form, so nothing in the stylesheet is read as a `$` replacement pattern.
  await page.setContent(o.font ? doc.replace(css, () => withFont(css, o.font!)) : doc);
  if (r.person) await page.evaluate(`void (${watchDock.toString()})()`);
  if (r.hydrate === "google") {
    await page.evaluate(`(() => {
      window.google = { accounts: { id: {
        initialize: () => {},
        renderButton: (parent, o) => {
          const b = document.createElement("div");
          b.setAttribute("data-gis-stub", "");
          b.style.width = Math.min(o.width, 400) + "px";
          b.style.height = "40px";
          parent.append(b);
        },
      } } };
      for (const w of document.querySelectorAll("[data-google]")) (${fitGoogleButton.toString()})(w, w.firstElementChild, "signin_with");
    })()`);
    if (!(await page.evaluate(`!!document.querySelector("[data-gis-stub]")`))) throw new Error(`${nameOf(r)}: Google's stand-in was not drawn`);
  }
  if (r.hydrate === "install-sheet") {
    await page.evaluate(`(() => {
      document.querySelector("main h1").insertAdjacentHTML("afterend", ${JSON.stringify(sheetMarkup)});
      (${watchSheet.toString()})(document.querySelector('[data-banner="install"]'));
    })()`);
  }
  await settle(page);
  // Nothing to close: the page belongs to the file and the next reading navigates it away.
  return { page, close: async () => {} };
}

// ---- the readings ---------------------------------------------------------------------------------

type Width = { scrollWidth: number; clientWidth: number; past: string[] };

/**
 * The page's scroll width, and what ends past its right edge: the innermost boxes, and the text
 * runs, which overflow a box that is itself inside the screen (a long address in a list item).
 */
const READ_WIDTH = `(() => { ${LABEL}
  const root = document.documentElement;
  const vw = root.clientWidth;
  const free = (el) => !(el.parentElement && el.parentElement.closest("[data-scroll-x]"));
  const past = [...document.body.querySelectorAll("*")].filter((el) => {
    if (!free(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > vw + 0.5 && el.checkVisibility();
  });
  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !free(n) || el.closest("script, style") || !el.checkVisibility()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const right = Math.max(...[...range.getClientRects()].map((b) => b.right));
    if (right > vw + 0.5) runs.push("text " + JSON.stringify(n.textContent.trim().slice(0, 28)) + " in " + label(el).split(" ")[0] + " to " + Math.round(right) + "px");
  }
  return {
    scrollWidth: root.scrollWidth,
    clientWidth: vw,
    past: [...innermost(past).slice(0, 4).map((el) => label(el) + " to " + Math.round(el.getBoundingClientRect().right) + "px"), ...runs.slice(0, 3)],
  };
})()`;

/**
 * Every element carrying text whose content is wider than its own box, innermost first: clipped
 * where it hides overflow, spilling where it does not. Inline boxes have no width of their own
 * (their overflow is their block's), form fields scroll their own text, and a `data-scroll-x`
 * container and what is inside it scroll sideways on purpose.
 */
const READ_CLIPPED = `(() => { ${LABEL}
  const clipped = [...document.body.querySelectorAll("*")].filter((el) => {
    if (el.closest("[data-scroll-x], svg, script, style, select, textarea")) return false;
    if (el.matches("input, option")) return false;
    if (!(el.textContent || "").trim()) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "inline" || cs.display === "contents" || !el.checkVisibility()) return false;
    return el.scrollWidth > el.clientWidth;
  });
  // What crosses the box's own right edge, so the reading names the cause and not only the box.
  const widest = (el) => {
    const edge = el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
    const over = [...el.querySelectorAll("*")].filter((c) => c.getBoundingClientRect().right > edge + 0.5);
    const inner = innermost(over)[0];
    return inner ? " (" + label(inner) + " to " + Math.round(inner.getBoundingClientRect().right - edge) + "px over)" : "";
  };
  return innermost(clipped).slice(0, 6).map((el) => label(el) + " " + el.scrollWidth + " in " + el.clientWidth + widest(el));
})()`;

const WIDTHS = [320, 360, 390, 768, 1280, 1920];
const TEXT_WIDTHS = [320, 390];

describe("the sweep covers every page route on disk (#251 AC 1)", () => {
  it("one or more renders per page.tsx under src/app, and no render for a route that is not there", () => {
    const onDisk = routesOnDisk().sort();
    const swept = [...new Set(RENDERS.map((r) => r.route))].sort();
    console.log(`#251 ${onDisk.length} routes on disk, ${RENDERS.length} renders`);
    expect(onDisk.length, "the walk found the app's routes at all").toBeGreaterThan(20);
    expect(swept).toEqual(onDisk);
  });

  it("every render rendered", () => {
    expect([...renderErrors.entries()].map(([name, e]) => `${name}: ${e.split("\n")[0]}`)).toEqual([]);
    expect(docs.size).toBe(RENDERS.length);
  });
});

/**
 * Every table part laid out as one. A board hook on an admin table's row (`<tr data-post>`) made it
 * a flex box on develop, its cells stacked one per line, and a squashed table is NARROWER, so no
 * width reading can see it. This is the reading that holds the hooks' scoping.
 */
const READ_TABLE_PARTS = `(() => { ${LABEL}
  const want = { TR: "table-row", TD: "table-cell", TH: "table-cell", THEAD: "table-header-group", TBODY: "table-row-group" };
  return [...document.querySelectorAll("table, table *")]
    .filter((el) => want[el.tagName] && getComputedStyle(el).display !== want[el.tagName])
    .slice(0, 4)
    .map((el) => label(el) + " is " + getComputedStyle(el).display);
})()`;

describe("no page scrolls sideways at 320, 360, 390, 768, 1280 or 1920px (#251 AC 1)", () => {
  it.each(RENDERS.map((r) => ({ name: nameOf(r), r })))("$name", async ({ r }) => {
    const { page, close } = await open(r, { viewport: { width: WIDTHS[0], height: 800 } });
    try {
      // The context is shared with AC 2's 200% pages; ordinary text has to be ordinary here.
      expect(await page.evaluate(`getComputedStyle(document.documentElement).fontSize`), "the browser's text is at 100%").toBe("16px");
      const failed: string[] = [];
      const parts = (await page.evaluate(READ_TABLE_PARTS)) as string[];
      if (parts.length) failed.push(`a table laid out as something else: ${parts.join(" | ")}`);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await settle(page);
        const w = (await page.evaluate(READ_WIDTH)) as Width;
        if (w.scrollWidth !== w.clientWidth) failed.push(`${width}px: ${w.scrollWidth} wide in ${w.clientWidth}, past the edge: ${w.past.join(" | ")}`);
      }
      console.log(`#251 AC 1 ${nameOf(r)}: ${failed.length ? failed.join("; ") : "fits at every width"}`);
      expect(failed, `${nameOf(r)} scrolls sideways: ${failed.join("; ")}`).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("at 200% text on 320 and 390px, nothing scrolls sideways and no text outgrows its box (#251 AC 2)", () => {
  it.each(RENDERS.map((r) => ({ name: nameOf(r), r })))("$name", async ({ r }) => {
    const failed: string[] = [];
    for (const font of [undefined, WIDE_FONT]) {
      const { page, close } = await open(r, { viewport: { width: TEXT_WIDTHS[0], height: 800 }, text: 2, font });
      try {
        expect(await page.evaluate(`getComputedStyle(document.documentElement).fontSize`), "the browser's text is at 200%").toBe("32px");
        if (font) expect(await page.evaluate(`getComputedStyle(document.body).fontFamily`), "the wide font is the body's").toBe(font);
        for (const width of TEXT_WIDTHS) {
          await page.setViewportSize({ width, height: 800 });
          await settle(page);
          const w = (await page.evaluate(READ_WIDTH)) as Width;
          const clipped = (await page.evaluate(READ_CLIPPED)) as string[];
          const at = `${width}px${font ? " in Verdana" : ""}`;
          if (w.scrollWidth !== w.clientWidth) failed.push(`${at}: ${w.scrollWidth} wide in ${w.clientWidth}, past the edge: ${w.past.join(" | ")}`);
          if (clipped.length) failed.push(`${at}: text wider than its box: ${clipped.join(" | ")}`);
        }
      } finally {
        await close();
      }
    }
    console.log(`#251 AC 2 ${nameOf(r)}: ${failed.length ? failed.join("; ") : "fits at 200%"}`);
    expect(failed, `${nameOf(r)} at 200% text: ${failed.join("; ")}`).toEqual([]);
  });
});

/**
 * The controls a Tab walk should reach in `<main>`, marked `data-reflow-c`. A radio group is one
 * stop (the checked radio, else the first), a closed `<details>` hides its fields from Tab while
 * leaving them rects (`checkVisibility()` knows), and a date field's four presses are one element.
 * Cairn: `chrome-tab-walk-video-details-radios-2026-10-11`, `chrome-date-input-picker-…`.
 */
const MARK_CONTROLS = `(() => {
  const main = document.querySelector("#main main") || document.querySelector("main");
  // A sideways-scrolling region is named here as well as by its tabindex, so one that stops being a
  // Tab stop reads as never reached rather than dropping out of the list.
  const all = [...main.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [data-scroll-x]')]
    .filter((el) => !el.disabled && el.checkVisibility());
  const groups = new Map();
  const controls = all.filter((el) => {
    if (!(el.matches('input[type="radio"]') && el.name)) return true;
    const key = (el.form ? "f" + [...document.forms].indexOf(el.form) : "") + ":" + el.name;
    if (!groups.has(key)) groups.set(key, [...main.querySelectorAll('input[type="radio"]')].filter((o) => o.name === el.name && o.form === el.form));
    const group = groups.get(key);
    return el === (group.find((o) => o.checked) || group[0]);
  });
  controls.forEach((el, i) => el.setAttribute("data-reflow-c", String(i)));
  return controls.length;
})()`;

type Stop = { where: "none" | "after" | "other" } | { where: "main"; i: number; ok: boolean; label: string; hit: string };

/** Where Tab landed, and what is painted at the centre of the control it landed on. */
const READ_STOP = `(() => { ${LABEL}
  const el = document.activeElement;
  if (!el || el === document.body) return { where: "none" };
  if (el.closest("[data-about], footer")) return { where: "after" };
  const i = el.getAttribute("data-reflow-c");
  if (i === null) return { where: "other" };
  // An inline link wrapped over two lines has two boxes; the centre of their union can be text
  // beside it, so the largest box is the one read.
  const boxes = [...el.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
  const b = boxes.sort((p, q) => q.width * q.height - p.width * p.height)[0] || el.getBoundingClientRect();
  // The centre of the part of it on the screen: a table's region is taller than the room above the
  // dock at 400%, and Tab rightly brings its top into view. A control half under the nav still
  // fails, because the part on the screen includes the strip under the nav.
  const top = Math.max(b.top, 0), bottom = Math.min(b.bottom, innerHeight);
  const left = Math.max(b.left, 0), right = Math.min(b.right, document.documentElement.clientWidth);
  const onScreen = bottom > top && right > left;
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const hit = onScreen ? document.elementFromPoint(x, y) : null;
  return {
    where: "main", i: Number(i), label: label(el),
    ok: !!hit && (hit === el || el.contains(hit)),
    hit: hit ? label(hit) : "nothing: it is off the screen, " + Math.round(b.top) + "–" + Math.round(b.bottom) + "px of " + innerHeight,
  };
})()`;

describe("at 400% zoom every control in <main> is reached by Tab and is on top where it lands (#251 AC 3)", () => {
  it.each(RENDERS.map((r) => ({ name: nameOf(r), r })))("$name", async ({ r }) => {
    // Chrome at 400% on a 1280 × 1024 window: a 320 × 256 CSS-pixel viewport, 4 device pixels each.
    const { page, close } = await open(r, { viewport: { width: 320, height: 256 }, scale: 4 });
    try {
      const count = (await page.evaluate(MARK_CONTROLS)) as number;
      const seen = new Map<number, Extract<Stop, { where: "main" }>>();
      for (let press = 0; press < count * 4 + 30; press++) {
        await page.keyboard.press("Tab");
        const stop = (await page.evaluate(READ_STOP)) as Stop;
        if (stop.where === "after") break;
        if (stop.where === "main" && !seen.has(stop.i)) seen.set(stop.i, stop);
      }
      const covered = [...seen.values()].filter((s) => !s.ok).map((s) => `${s.label} under ${s.hit}`);
      const missed = Array.from({ length: count }, (_, i) => i).filter((i) => !seen.has(i));
      const missedLabels = (await page.evaluate(`(${JSON.stringify(missed)}).map((i) => { ${LABEL} return label(document.querySelector('[data-reflow-c="' + i + '"]')); })`)) as string[];
      const dock = (await page.evaluate(`(() => { const n = document.querySelector("[data-nav][data-signed-in]"); return n && getComputedStyle(n).position === "fixed" ? Math.round(n.getBoundingClientRect().height) : 0; })()`)) as number;
      console.log(
        `#251 AC 3 ${nameOf(r)}: ${seen.size} of ${count} controls reached, dock ${dock}px` +
          (covered.length ? `; covered: ${covered.join(" | ")}` : "") +
          (missedLabels.length ? `; never reached: ${missedLabels.join(" | ")}` : ""),
      );
      expect(count, `${nameOf(r)} has a control in <main>`).toBeGreaterThan(0);
      expect(covered, `${nameOf(r)} at 400% zoom, covered where Tab put it: ${covered.join(" | ")}`).toEqual([]);
      expect(missedLabels, `${nameOf(r)} at 400% zoom, never reached by Tab: ${missedLabels.join(" | ")}`).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("a label sits above its value on a narrow screen at large text, and beside it otherwise (#251)", () => {
  // Without the stacking rule nothing overflows: the value's track takes what the label leaves, and
  // at 200% text on 320px that is 59px, so "Lovelace" breaks mid-word. No width reading sees that.
  type Pair = { dt: string; beside: boolean };
  const pairs = async (o: Open) => {
    const { page, close } = await open(RENDERS.find((r) => r.route === "/profile")!, o);
    try {
      return (await page.evaluate(`[...document.querySelectorAll("main [data-pairs] > dt")].map((dt) => {
        const dd = dt.nextElementSibling;
        return { dt: dt.textContent.trim(), beside: Math.round(dd.getBoundingClientRect().top) === Math.round(dt.getBoundingClientRect().top) };
      })`)) as Pair[];
    } finally {
      await close();
    }
  };

  it("/welcome at 200% text on 320px: a newcomer's 'Signed in as <address>' keeps the header's width, with Sign out under it", async () => {
    // Without the identity line's wrap nothing overflows either: the address narrows beside Sign out
    // and breaks every few letters. This holds the wrap.
    const { page, close } = await open(RENDERS.find((r) => r.route === "/welcome")!, { viewport: { width: 320, height: 800 }, text: 2 });
    try {
      const read = (await page.evaluate(`(() => {
        const who = document.querySelector("[data-who]").getBoundingClientRect();
        const out = document.querySelector("[data-signout]").getBoundingClientRect();
        const bar = document.querySelector("[data-brand-bar]");
        const room = bar.clientWidth - parseFloat(getComputedStyle(bar).paddingLeft) - parseFloat(getComputedStyle(bar).paddingRight);
        return { who: Math.round(who.width), room: Math.round(room), below: out.top >= who.bottom - 0.5 };
      })()`)) as { who: number; room: number; below: boolean };
      console.log(`#251 identity at 200%/320: ${JSON.stringify(read)}`);
      expect(read.below, "Sign out is under the identity line").toBe(true);
      expect(read.who, "the identity line has the header's width").toBe(read.room);
    } finally {
      await close();
    }
  });

  it("/profile at 200% text on 320px: every value under its label; at ordinary text on 320 and 390px, beside it", async () => {
    const large = await pairs({ viewport: { width: 320, height: 800 }, text: 2 });
    const ordinary320 = await pairs({ viewport: { width: 320, height: 800 } });
    const ordinary390 = await pairs({ viewport: { width: 390, height: 800 } });
    console.log(`#251 pairs: 200%/320 ${JSON.stringify(large)}; 100%/320 ${JSON.stringify(ordinary320)}; 100%/390 ${JSON.stringify(ordinary390)}`);
    expect(large.length, "the profile has label/value pairs").toBeGreaterThan(2);
    for (const p of large) expect(p.beside, `200%/320: ${p.dt} is above its value`).toBe(false);
    for (const p of [...ordinary320, ...ordinary390]) expect(p.beside, `ordinary text: ${p.dt} is beside its value`).toBe(true);
  });
});

describe("which 200% the sweep exercises: the browser's own text size, which moves the 40rem breakpoint", () => {
  it("at 768px the nav docks under the browser's 200% text, and does not under a 200% root font size", async () => {
    const board = RENDERS.find((r) => r.route === "/board" && !r.variant)!;
    const docked = async (o: Open, root?: string) => {
      const { page, close } = await open(board, o);
      try {
        if (root) {
          await page.evaluate(`document.documentElement.style.fontSize = ${JSON.stringify(root)}`);
          await settle(page);
        }
        return (await page.evaluate(`({
          root: getComputedStyle(document.documentElement).fontSize,
          nav: getComputedStyle(document.querySelector("[data-nav][data-signed-in]")).position,
        })`)) as { root: string; nav: string };
      } finally {
        await close();
      }
    };
    const viewport = { width: 768, height: 800 };
    const plain = await docked({ viewport });
    const browserText = await docked({ viewport, text: 2 });
    const rootText = await docked({ viewport }, "200%");
    console.log(`#251 768px: default ${JSON.stringify(plain)}; browser 200% ${JSON.stringify(browserText)}; root 200% ${JSON.stringify(rootText)}`);
    expect(plain).toEqual({ root: "16px", nav: "static" });
    expect(browserText).toEqual({ root: "32px", nav: "fixed" });
    expect(rootText).toEqual({ root: "32px", nav: "static" });
  });
});
