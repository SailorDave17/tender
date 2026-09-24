import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { chromium, type Browser } from "playwright-core";
import { fitGoogleButton } from "@/auth/GoogleButton";
import { GLOBALS_CSS } from "./tokens";
import { IDS, ME, NOW, fakeClient } from "./surfaces";

/**
 * Story #155 — the six member-facing surfaces, rendered from the token layer and read in Chrome.
 * #147 added /support and /privacy to the contrast sweep (AC 8's cases below); the other ACs are
 * still about the six.
 *
 * AC 1: no inline `style={{` survives on the surfaces except one the token layer cannot express,
 *       and that one carries a `token-exempt:` comment (a corpus scan; the needle is built from
 *       fragments so this file is not its own hit).
 * AC 2: /board at 390 px — every post a distinct row under its day, the day's heading separated
 *       from its posts by rules of ours, the boat / class / time / rung at a legible size, and no
 *       horizontal scroll.
 * AC 6: the join tabs — the selected one is filled, the other is not, read as computed colours.
 * AC 8: the contrast proof extended to the RENDERED surfaces: every element with text on every
 *       surface, in both schemes, with the ratio computed from Chrome's own `color` and the first
 *       opaque background behind it, and the lowest three printed per surface and scheme.
 *
 * The pages are the real Server Components rendered through the real root layout; what is faked
 * is the database (test/surfaces.ts), the club row, the session, the cookie jar and the Server
 * Actions, none of which paint anything. `Date` is pinned so the fixture's Sunday series is where
 * the pages expect it.
 */

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => holder.client }));
vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({
  currentPerson: async () => ({ id: "p-ada", email: "ada@example.test", displayName: "Ada Lovelace", isAdmin: false }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
}));
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
// #147: /support reads the club row's address as the service role, behind `server-only`.
vi.mock("@/support/contact", () => ({ loadSupportAddress: async () => "someone@club.example.test" }));

const css = readFileSync(GLOBALS_CSS, "utf8");
const SRC = fileURLToPath(new URL("../src/", import.meta.url)).replace(/[\\/]$/, "");

type Surface = { name: string; as: string; render: () => Promise<ReactNode> };
const SURFACES: Surface[] = [
  { name: "/board", as: ME, render: async () => (await import("@/app/board/page")).default({ searchParams: Promise.resolve({}) }) },
  {
    name: "/post/[id] (skipper, open)",
    as: ME,
    render: async () => (await import("@/app/post/[id]/page")).default({ params: Promise.resolve({ id: IDS.postOpen }), searchParams: Promise.resolve({}) }),
  },
  {
    name: "/post/[id] (crew, matched)",
    as: "p-cy",
    render: async () => (await import("@/app/post/[id]/page")).default({ params: Promise.resolve({ id: IDS.postCrewed }), searchParams: Promise.resolve({}) }),
  },
  { name: "/post/new", as: ME, render: async () => (await import("@/app/post/new/page")).default({ searchParams: Promise.resolve({ boat: IDS.boatMoon }) }) },
  { name: "/join", as: "", render: async () => (await import("@/app/join/page")).default({ searchParams: Promise.resolve({}) }) },
  { name: "/profile", as: ME, render: async () => (await import("@/app/profile/page")).default({ searchParams: Promise.resolve({}) }) },
  { name: "/boats", as: ME, render: async () => (await import("@/app/boats/page")).default({ searchParams: Promise.resolve({}) }) },
  // #147: the two open pages. They paint from the same base rules and carry no hooks of their own,
  // so the sweep is what says the shell's new About links and the prose clear their bars.
  { name: "/support", as: "", render: async () => (await import("@/app/support/page")).default() },
  { name: "/privacy", as: "", render: async () => (await import("@/app/privacy/page")).default() },
];

/**
 * #227: /join with the Google option on, one render per tab. Kept out of SURFACES so the contrast
 * sweep's case count does not move; the page reads the client id from its environment at render.
 */
const JOIN_TABS = ["signin", "signup"] as const;
const joinWithGoogle = (tab: (typeof JOIN_TABS)[number]) => `/join with Google, ${tab} tab`;

const pages = new Map<string, string>();
let browser: Browser;

beforeAll(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    const { default: RootLayout } = await import("@/app/layout");
    const extra = JOIN_TABS.map((tab) => ({
      name: joinWithGoogle(tab),
      as: "",
      render: async () => (await import("@/app/join/page")).default({ searchParams: Promise.resolve({ mode: tab }) }),
      env: { NEXT_PUBLIC_GOOGLE_CLIENT_ID: "000000000000-surfaces.apps.googleusercontent.com" },
    }));
    for (const s of [...SURFACES, ...extra]) {
      holder.client = fakeClient(s.as);
      for (const [k, v] of Object.entries("env" in s ? s.env : {})) vi.stubEnv(k, v);
      try {
        const doc = renderToStaticMarkup(await RootLayout({ children: await s.render() }));
        const html = `<!doctype html>${doc.replace("<body>", `<head><style>${css}</style></head><body>`)}`;
        if (!html.includes("<style>")) throw new Error(`${s.name}: no <body> to attach the stylesheet to`);
        pages.set(s.name, html);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  } finally {
    vi.useRealTimers();
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 90_000);

afterAll(async () => {
  await browser?.close();
});

const IN_PAGE = `
  const lum = (s) => {
    const [r, g, b] = s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
    const ch = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const opaque = (s) => s && s !== "transparent" && !/rgba\\([^)]*,\\s*0\\)$/.test(s);
  const surfaceOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (opaque(bg)) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
`;

type TextItem = { label: string; fg: string; bg: string; ratio: number; bar: number };

async function open(name: string, viewport: { width: number; height: number }, scheme: "light" | "dark") {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  const page = await context.newPage();
  await page.setContent(pages.get(name)!);
  return { page, close: () => context.close() };
}

async function sweep(name: string, scheme: "light" | "dark"): Promise<{ items: TextItem[]; scrollWidth: number }> {
  const { page, close } = await open(name, { width: 390, height: 800 }, scheme);
  try {
    return (await page.evaluate(`(() => { ${IN_PAGE}
      const items = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.closest("svg, script, style, select")) continue;
        const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const px = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const hooks = Object.keys(el.dataset).slice(0, 1).map((k) => "[" + k + "]").join("");
        items.push({
          label: el.tagName.toLowerCase() + hooks + " " + JSON.stringify(text.slice(0, 26)),
          fg: cs.color, bg: surfaceOf(el), ratio: ratio(cs.color, surfaceOf(el)),
          bar: px >= 24 || (bold && px >= 18.66) ? 3 : 4.5,
        });
      }
      return { items, scrollWidth: document.documentElement.scrollWidth };
    })()`)) as { items: TextItem[]; scrollWidth: number };
  } finally {
    await close();
  }
}

describe("every text element on every surface clears its bar, computed in Chrome (#155 AC 8)", () => {
  const cases = SURFACES.flatMap((s) => (["light", "dark"] as const).map((scheme) => ({ name: s.name, scheme })));
  it.each(cases)("$scheme $name", async ({ name, scheme }) => {
    const { items, scrollWidth } = await sweep(name, scheme);
    expect(items.length, `${name} has text`).toBeGreaterThan(10);
    const lowest = [...items].sort((a, b) => a.ratio - b.ratio).slice(0, 3);
    console.log(
      `${scheme.padEnd(5)} ${name.padEnd(28)} ${String(items.length).padStart(3)} text elements; lowest: ` +
        lowest.map((i) => `${i.label} ${i.fg} on ${i.bg} ${i.ratio.toFixed(2)}:1 (bar ${i.bar})`).join(" | "),
    );
    for (const i of items) expect(i.ratio, `${scheme} ${name}: ${i.label} ${i.fg} on ${i.bg}`).toBeGreaterThanOrEqual(i.bar);
    expect(scrollWidth, `${name} scrolls sideways at 390px`).toBeLessThanOrEqual(390);
  });
});

describe("/board on a 390px phone: rows, a separated day heading, legible without zoom (#155 AC 2)", () => {
  it("each race day is a card, its posts a ruled list under the heading, at readable sizes", async () => {
    const { page, close } = await open("/board", { width: 390, height: 800 }, "light");
    try {
      const read = (await page.evaluate(`(() => {
        const px = (v) => parseFloat(v);
        const body = getComputedStyle(document.body).backgroundColor;
        const days = [...document.querySelectorAll("[data-race-date]")].map((d) => {
          const cs = getComputedStyle(d);
          const heading = d.querySelector("[data-day] > strong");
          const posts = d.querySelector("[data-posts]");
          const pcs = posts ? getComputedStyle(posts) : null;
          return {
            id: d.getAttribute("data-race-date"),
            border: px(cs.borderTopWidth), bg: cs.backgroundColor, bodyBg: body,
            headingPx: heading ? px(getComputedStyle(heading).fontSize) : null,
            posts: posts ? {
              rule: px(pcs.borderTopWidth), padTop: px(pcs.paddingTop), marginTop: px(pcs.marginTop),
              rows: [...posts.querySelectorAll("[data-post]")].map((li) => {
                const a = li.querySelector("a");
                const badge = li.querySelector('[data-badge="rung"]');
                return {
                  post: li.getAttribute("data-post"),
                  width: li.getBoundingClientRect().width,
                  linkPx: a ? px(getComputedStyle(a).fontSize) : null,
                  badgePx: badge ? px(getComputedStyle(badge).fontSize) : null,
                  badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
                };
              }),
            } : null,
          };
        });
        return { days, scrollWidth: document.documentElement.scrollWidth, space2: px(getComputedStyle(document.documentElement).getPropertyValue("--space-2")) * 16 };
      })()`)) as {
        days: { id: string; border: number; bg: string; bodyBg: string; headingPx: number | null; posts: { rule: number; padTop: number; marginTop: number; rows: { post: string; width: number; linkPx: number | null; badgePx: number | null; badgeBg: string | null }[] } | null }[];
        scrollWidth: number;
      };
      console.log(JSON.stringify(read, null, 1).slice(0, 2000));
      expect(read.days.map((d) => d.id)).toEqual(["d-past", "d-next", "d-later"]);
      expect(read.scrollWidth).toBeLessThanOrEqual(390);
      for (const d of read.days) {
        expect(d.border, `${d.id} is a card`).toBeGreaterThanOrEqual(1);
        expect(d.bg, `${d.id} is a card`).not.toBe(d.bodyBg);
        expect(d.headingPx, `${d.id} heading`).toBeGreaterThanOrEqual(20);
      }
      const next = read.days.find((d) => d.id === "d-next")!;
      expect(next.posts, "the next Sunday has posts").not.toBeNull();
      // the heading is separated from its posts by our rule and our spacing, not the browser's <ul> margins
      expect(next.posts!.rule).toBeGreaterThanOrEqual(1);
      expect(next.posts!.padTop).toBe(8);
      expect(next.posts!.marginTop).toBe(8);
      expect(next.posts!.rows.map((r) => r.post)).toEqual([IDS.postOpen, IDS.postCrewed]);
      for (const r of next.posts!.rows) {
        expect(r.width).toBeLessThanOrEqual(390 - 2 * 16);
        expect(r.linkPx, `${r.post} boat/class`).toBeGreaterThanOrEqual(16);
      }
      const openRow = next.posts!.rows[0];
      expect(openRow.badgePx, "the rung badge").toBeGreaterThanOrEqual(14);
      expect(openRow.badgeBg).toBe("rgb(30, 84, 67)"); // rung 1's fill, from --rung
    } finally {
      await close();
    }
  });
});

describe("the join tabs: the selected tab is visibly selected (#155 AC 6)", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: filled versus outlined, read as computed colours`, async () => {
      const { page, close } = await open("/join", { width: 390, height: 800 }, scheme);
      try {
        const read = (await page.evaluate(`(() => { ${IN_PAGE}
          const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => {
            const cs = getComputedStyle(t);
            return { mode: t.getAttribute("data-mode"), selected: t.getAttribute("aria-selected") === "true", bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor, ratio: ratio(cs.color, cs.backgroundColor) };
          });
          return tabs;
        })()`)) as { mode: string; selected: boolean; bg: string; fg: string; border: string; ratio: number }[];
        for (const t of read) console.log(`${scheme.padEnd(5)} tab ${t.mode.padEnd(6)} selected=${t.selected} ${t.fg} on ${t.bg} border ${t.border} ${t.ratio.toFixed(2)}:1`);
        expect(read).toHaveLength(2);
        const on = read.find((t) => t.selected)!;
        const off = read.find((t) => !t.selected)!;
        expect(on, "one tab is selected").toBeTruthy();
        expect(on.bg).not.toBe(off.bg);
        expect(on.border).not.toBe(off.border);
        expect(on.ratio).toBeGreaterThanOrEqual(4.5);
        expect(off.ratio).toBeGreaterThanOrEqual(4.5);
      } finally {
        await close();
      }
    });
  }
});

describe("Google's button is as wide as its slot, so /join does not scroll sideways (#227)", () => {
  // The rendered HTML carries GoogleButton's empty wrapper and slot; GIS never loads here. The
  // stand-in draws what GIS's real script was *measured* to draw (2026-09-24, fake client id): a
  // block exactly the requested width, 400px at most. `fitGoogleButton` is the component's own
  // function, handed to Chrome the way `watchDock` is in `test/install-sheet.test.ts`.
  const GIS = `
    window.__asked = [];
    window.google = { accounts: { id: {
      initialize: () => {},
      renderButton: (parent, o) => {
        window.__asked.push(o.width);
        const b = document.createElement("div");
        b.setAttribute("data-gis-stub", "");
        b.style.width = Math.min(o.width, 400) + "px";
        b.style.height = "40px";
        parent.append(b);
      },
    } } };
  `;
  const FIT = `(${fitGoogleButton.toString()})`;
  type Read = { viewport: number; scrollWidth: number; tab: string | null; wrapper: number; button: number; asked: number[] };
  const READ = `(() => {
    const w = document.querySelector("[data-google]");
    const b = w && w.querySelector("[data-gis-stub]");
    return {
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      tab: w && w.getAttribute("data-google"),
      wrapper: w ? w.clientWidth : 0,
      button: b ? b.getBoundingClientRect().width : 0,
      asked: window.__asked,
    };
  })()`;

  async function openJoin(tab: (typeof JOIN_TABS)[number], width: number) {
    const opened = await open(joinWithGoogle(tab), { width, height: 800 }, "light");
    await opened.page.evaluate(`(() => { ${GIS}
      for (const w of document.querySelectorAll("[data-google]")) ${FIT}(w, w.firstElementChild, "signin_with");
    })()`);
    return opened;
  }
  const read = async (page: import("playwright-core").Page) => (await page.evaluate(READ)) as Read;
  // A ResizeObserver reports in the frame after a resize; two frames and the redraw has landed.
  const settle = (page: import("playwright-core").Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  for (const tab of JOIN_TABS) {
    it(`${tab} tab at 320px: no horizontal scroll, and the button fills its slot (AC 1)`, async () => {
      const { page, close } = await openJoin(tab, 320);
      try {
        const r = await read(page);
        console.log(`#227 ${tab} 320px: slot ${r.wrapper}px, GIS asked for ${r.asked.join(",")}, scrollWidth ${r.scrollWidth}`);
        expect(r.tab, "the page rendered Google's slot on this tab").toBe(tab);
        expect(r.asked, "GIS was asked to draw once").toHaveLength(1);
        expect(r.scrollWidth).toBe(r.viewport);
        expect(r.button).toBe(r.wrapper);
        // The instrument can see a scroll on this page: the same slot drawn 40px too wide scrolls it.
        await page.evaluate(`document.querySelector("[data-gis-stub]").style.width = "${r.wrapper + 40}px"`);
        expect((await read(page)).scrollWidth, "control: an overflowing button scrolls the page").toBeGreaterThan(r.viewport);
      } finally {
        await close();
      }
    });

    it(`${tab} tab at 1280px: the button is at least 200px wide (AC 2)`, async () => {
      const { page, close } = await openJoin(tab, 1280);
      try {
        const r = await read(page);
        console.log(`#227 ${tab} 1280px: slot ${r.wrapper}px, GIS asked for ${r.asked.join(",")}, drawn ${r.button}px`);
        expect(r.button).toBeGreaterThanOrEqual(200);
        expect(r.button).toBe(Math.min(400, r.wrapper));
        expect(r.scrollWidth).toBe(r.viewport);
      } finally {
        await close();
      }
    });

    it(`${tab} tab turned from 1280px to 320px: redrawn to the narrower slot, no horizontal scroll`, async () => {
      const { page, close } = await openJoin(tab, 1280);
      try {
        const wide = await read(page);
        await page.setViewportSize({ width: 320, height: 800 });
        await settle(page);
        const narrow = await read(page);
        console.log(`#227 ${tab} 1280→320px: slot ${wide.wrapper}→${narrow.wrapper}px, GIS asked for ${narrow.asked.join(",")}, scrollWidth ${narrow.scrollWidth}`);
        expect(narrow.wrapper, "the slot narrowed with the screen").toBeLessThan(wide.wrapper);
        expect(narrow.asked, "drawn wide, then redrawn narrow").toEqual([Math.min(400, wide.wrapper), narrow.wrapper]);
        expect(narrow.scrollWidth).toBe(narrow.viewport);
      } finally {
        await close();
      }
    });
  }

  it("asks GIS for a width inside its 200–400px range, whatever the slot", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 400 } });
    try {
      const page = await context.newPage();
      await page.setContent(`<div data-w="150" style="width:150px"><div></div></div><div data-w="600" style="width:600px"><div></div></div>`);
      const asked = await page.evaluate(`(() => { ${GIS}
        for (const w of document.querySelectorAll("[data-w]")) ${FIT}(w, w.firstElementChild, "signin_with");
        return window.__asked;
      })()`);
      expect(asked).toEqual([200, 400]);
    } finally {
      await context.close();
    }
  });
});

describe("a short page keeps its footer under its content, not under a screen (#211 AC 2)", () => {
  // #211 hides the About links and the stamp only while loading.tsx is shown. The alternative it
  // was chosen over, #185's R2 (`#main[data-frame] { min-height: 100svh }`), holds a page's frame
  // at a viewport tall, so a short page ends in blank space above its footer. This reads what the
  // loaded page does: the frame is exactly its <main>, and the About links start where it ends.
  // All three render taller than 640px here, so this cannot see a viewport-tall frame (R2's rule
  // added left it green); `test/footer-streaming.test.ts` proves that on a page shorter than the
  // screen. This holds the three named pages to no gap at all.
  for (const name of ["/join", "/support", "/privacy"]) {
    it(`${name} at 360×640: no empty space between the content and the About links`, async () => {
      const { page, close } = await open(name, { width: 360, height: 640 }, "light");
      try {
        const read = (await page.evaluate(`(() => {
          const frame = document.getElementById("main").getBoundingClientRect();
          const main = document.querySelector("#main[data-frame] > main");
          const last = main.lastElementChild;
          const about = document.querySelector("[data-about]");
          return {
            frame: frame.height,
            main: main.getBoundingClientRect().height,
            content: last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom),
            padding: parseFloat(getComputedStyle(main).paddingBottom),
            about: about.getBoundingClientRect().top,
            display: getComputedStyle(about).display,
          };
        })()`)) as { frame: number; main: number; content: number; padding: number; about: number; display: string };
        const blank = read.about - read.content;
        console.log(`${name} 360×640: frame ${read.frame}px, main ${read.main}px, content ends ${read.content.toFixed(0)}px, About at ${read.about.toFixed(0)}px, blank ${blank.toFixed(0)}px (main padding ${read.padding}px)`);
        expect(read.display).toBe("flex");
        expect(Math.abs(read.frame - read.main)).toBeLessThan(1);
        expect(blank).toBeLessThanOrEqual(read.padding + 1);
      } finally {
        await close();
      }
    });
  }
});

describe("no surface carries an inline style the token layer could express (#155 AC 1)", () => {
  it("every style= left under the six surfaces and their components is token-exempt, with the reason on the line above", () => {
    const needle = ["style", "={{"].join("");
    const exempt = ["token", "-exempt:"].join("");
    const dirs = ["app/board", "app/post", "app/join", "app/profile", "app/boats", "post", "profile", "auth", "install", "push",
      // #147's two open pages and their loader
      "app/support", "app/privacy", "support"];
    const hits: string[] = [];
    const unexplained: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const lines = readFileSync(p, "utf8").split("\n");
          lines.forEach((line, i) => {
            if (!line.includes(needle)) return;
            const rel = `${p.slice(SRC.length + 1).replace(/\\/g, "/")}:${i + 1}`;
            hits.push(rel);
            if (!(lines[i - 1] ?? "").includes(exempt) && !line.includes(exempt)) unexplained.push(rel);
          });
        }
      }
    };
    for (const d of dirs) walk(`${SRC}/${d}`);
    console.log(`inline styles left: ${hits.join(", ") || "none"}`);
    expect(unexplained, "inline styles with no token-exempt reason").toEqual([]);
    // and the one survivor is the rung badge's data, not a design value
    expect(hits.map((h) => h.replace(/:\d+$/, ""))).toEqual(["post/CandidateList.tsx"]);
  });
});
