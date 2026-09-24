import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { chromium, type Browser, type Page } from "playwright-core";
import { InstallBannerView } from "@/install/InstallBanner";
import { installAdvice } from "@/install/prompt";
import { GLOBALS_CSS } from "./tokens";

/**
 * Story #217 — the install offer arrives without moving the race days, read from Chrome.
 *
 * Before #217 `InstallBanner` rendered an `<aside>` above the race-day list after hydration, and
 * only when the browser offered an install, so its arrival pushed the whole `<ol>` down: CLS on
 * `main > ol` in #44's reading and in all three of #216's `devtools` runs. The owner's call at
 * pickup was a sheet fixed to the bottom of the screen, above the phone's docked navigation.
 *
 * The page is the real root layout, signed in, with a board-shaped `<main>` and the real
 * stylesheet, in the machine's Chrome (`channel: "chrome"`, as the smoke and
 * `test/footer-streaming.test.ts` run it). The banner is the real `InstallBannerView` markup for
 * both wordings the decision returns, inserted after the heading where `src/app/board/page.tsx`
 * renders it — which is what hydration does when the effect resolves. Every shift reading is
 * paired with the same arrival under the stylesheet with #217's placement rule stripped, which
 * must move the list; otherwise a 0 says nothing about the rule.
 *
 * WHAT THIS CANNOT SEE: whether a real browser fires `beforeinstallprompt`, and when. That, and
 * the size the shift reaches on a throttled load, are `npm run perf:floor`'s; the reading is in
 * `docs/performance-floor.md`.
 */

vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({
  currentPerson: async () => ({ id: "p-cy", email: "cy@example.test", displayName: "Cy", isAdmin: false }),
}));

const css = readFileSync(GLOBALS_CSS, "utf8");

/** #217's placement rule, found by its first declaration. Exactly one, or the control proves nothing. */
const RULE = /\[data-banner="install"\] \{\s*position: fixed;[^}]*\}/g;

function withoutTheRule(sheet: string): string {
  const found = sheet.match(RULE) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one #217 placement rule in globals.css, found ${found.length}`);
  return sheet.replace(RULE, "");
}

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/124.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1";
const ADVICE = {
  "browser-prompt": installAdvice({ userAgent: ANDROID, standalone: false, dismissed: false, promptAvailable: true, maxTouchPoints: 5 }),
  "ios-share-sheet": installAdvice({ userAgent: IPHONE, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 5 }),
} as const;
type Kind = keyof typeof ADVICE;
const KINDS = Object.keys(ADVICE) as Kind[];

/** A board-shaped page: the heading, then thirty race days, each with a control to tap. */
function boardPage() {
  const h = createElement;
  const days = Array.from({ length: 30 }, (_, i) =>
    h("li", { key: i, "data-race-date": "" }, h("p", null, `Race day ${i + 1}`), h("button", { type: "button", "data-day-control": i }, "I can sail")),
  );
  return h("main", null, h("h1", null, "Tender"), h("ol", null, ...days));
}

const PHONES = [
  { name: "320×640", width: 320, height: 640 },
  { name: "360×640", width: 360, height: 640 },
  { name: "412×823 (Lighthouse mobile)", width: 412, height: 823 },
] as const;

let browser: Browser;
let boardDoc: string;
const banners = new Map<Kind, string>();

function withSheet(doc: string, sheet: string): string {
  const html = `<!doctype html>${doc.replace("<body>", `<head><style>${sheet}</style></head><body>`)}`;
  if (!html.includes("<style>")) throw new Error("the layout's <body> was not found to attach the stylesheet to");
  return html;
}

beforeAll(async () => {
  const { default: RootLayout } = await import("@/app/layout");
  boardDoc = renderToStaticMarkup(await RootLayout({ children: boardPage() }));
  for (const kind of KINDS) {
    const html = renderToStaticMarkup(createElement(InstallBannerView, { advice: ADVICE[kind] }));
    if (!html.includes(`data-install-advice="${kind}"`)) throw new Error(`${kind}: the view did not render that advice`);
    banners.set(kind, html);
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const FRAMES = `const frames = (n) => new Promise((done) => { const step = () => (n-- ? requestAnimationFrame(step) : done()); step(); });`;

/**
 * Open the board with a layout-shift observer running, then let the banner (or nothing) arrive
 * after the heading, as hydration does. Returns the tab, and the shifts the arrival caused.
 */
async function openBoard(sheet: string, viewport: { width: number; height: number }, kind: Kind | null): Promise<{ tab: Page; shifts: Shift[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport });
  const tab = await context.newPage();
  await tab.setContent(withSheet(boardDoc, sheet));
  const shifts = (await tab.evaluate(`(async () => { ${FRAMES}
    const name = (node) => {
      if (!node || node.nodeType !== 1) return String(node && node.nodeName);
      const hooks = [...node.attributes].filter((a) => a.name.startsWith("data-") || a.name === "id").map((a) => "[" + a.name + "]").join("");
      return node.tagName.toLowerCase() + hooks;
    };
    const shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) shifts.push({ value: e.value, sources: (e.sources || []).map((s) => name(s.node)) });
    }).observe({ type: "layout-shift", buffered: true });
    await frames(3);
    shifts.length = 0;
    const banner = ${JSON.stringify(kind ? banners.get(kind) : "")};
    if (banner) document.querySelector("main h1").insertAdjacentHTML("afterend", banner);
    await frames(3);
    await new Promise((done) => setTimeout(done, 100));
    return shifts;
  })()`)) as Shift[];
  return { tab, shifts, close: () => context.close() };
}

type Shift = { value: number; sources: string[] };
const total = (shifts: Shift[]) => shifts.reduce((sum, s) => sum + s.value, 0);
const fmt = (shifts: Shift[]) =>
  `CLS ${total(shifts).toFixed(4)} [${shifts.map((s) => `${s.value.toFixed(4)} ${s.sources.join(",")}`).join("; ") || "no shifts"}]`;

describe("the banner's arrival moves nothing on the board (#217 AC 1's mechanism)", () => {
  for (const vp of PHONES) {
    for (const kind of KINDS) {
      it(`${kind} at ${vp.name}: no shift with the sheet, the list shifts without it`, async () => {
        const fixed = await openBoard(css, vp, kind);
        await fixed.close();
        const control = await openBoard(withoutTheRule(css), vp, kind);
        await control.close();
        console.log(`${kind} ${vp.name} with #217: ${fmt(fixed.shifts)}`);
        console.log(`${kind} ${vp.name} without:   ${fmt(control.shifts)}`);

        // The control: the same arrival in the flow pushes the race days down, and Chrome says so.
        expect(total(control.shifts)).toBeGreaterThan(0);
        expect(control.shifts.some((s) => s.sources.includes("ol"))).toBe(true);

        expect(fixed.shifts).toEqual([]);
      });
    }
  }
});

describe("the sheet is on screen, clear of the navigation, and hides nothing for good (#217 AC 2)", () => {
  for (const vp of PHONES) {
    for (const kind of KINDS) {
      it(`${kind} at ${vp.name}: its actions are on top and reachable, and nothing is left under it`, async () => {
        const { tab, close } = await openBoard(css, vp, kind);
        try {
          const placed = (await tab.evaluate(`(() => {
            const aside = document.querySelector('[data-banner="install"]');
            const rect = aside.getBoundingClientRect();
            const nav = document.querySelector("[data-nav][data-signed-in]");
            const probe = document.createElement("div");
            probe.style.height = "var(--install-sheet)";
            document.body.appendChild(probe);
            const ceiling = probe.getBoundingClientRect().height;
            probe.remove();
            return {
              position: getComputedStyle(aside).position,
              top: rect.top, bottom: rect.bottom, height: rect.height,
              navTop: nav && getComputedStyle(nav).position === "fixed" ? nav.getBoundingClientRect().top : null,
              ceiling,
              actions: [...aside.querySelectorAll("[data-install-action]")].map((b) => {
                const r = b.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { action: b.getAttribute("data-install-action"), height: r.height, onTop: b === hit || b.contains(hit) };
              }),
            };
          })()`)) as {
            position: string; top: number; bottom: number; height: number; navTop: number | null; ceiling: number;
            actions: { action: string; height: number; onTop: boolean }[];
          };
          console.log(`${kind} ${vp.name}: sheet ${placed.top.toFixed(0)}–${placed.bottom.toFixed(0)}px (${placed.height.toFixed(0)} of a ${placed.ceiling}px ceiling), nav at ${placed.navTop}`);

          expect(placed.position).toBe("fixed");
          expect(placed.top).toBeGreaterThanOrEqual(0);
          expect(placed.navTop, "a signed-in phone docks its navigation").not.toBeNull();
          expect(placed.bottom).toBeLessThanOrEqual(placed.navTop!);
          // --install-sheet is the room the page makes; a sheet taller than it would cover the foot.
          expect(placed.height).toBeLessThanOrEqual(placed.ceiling);
          expect(placed.actions.map((a) => a.action).sort()).toEqual(kind === "browser-prompt" ? ["dismiss", "prompt"] : ["dismiss"]);
          for (const a of placed.actions) {
            expect(a.onTop, `${a.action} is the element at its own centre`).toBe(true);
            expect(a.height).toBeGreaterThanOrEqual(44);
          }

          // Scrolled to the foot, the last race day and the stamp both end above the sheet.
          const foot = (await tab.evaluate(`(async () => { ${FRAMES}
            window.scrollTo(0, document.documentElement.scrollHeight);
            await frames(2);
            return {
              lastDay: document.querySelector("main ol > li:last-child").getBoundingClientRect().bottom,
              stamp: document.querySelector("footer[data-build-stamp]").getBoundingClientRect().bottom,
              sheetTop: document.querySelector('[data-banner="install"]').getBoundingClientRect().top,
            };
          })()`)) as { lastDay: number; stamp: number; sheetTop: number };
          expect(foot.lastDay).toBeLessThanOrEqual(foot.sheetTop);
          expect(foot.stamp).toBeLessThanOrEqual(foot.sheetTop);

          // Back at the top, Tab onto the first race-day control the sheet covers. The browser
          // scrolls a newly focused element into view, and scroll-padding is what puts it above
          // the sheet rather than behind it (WCAG 2.4.11).
          const covered = (await tab.evaluate(`(async () => { ${FRAMES}
            window.scrollTo(0, 0);
            await frames(2);
            const top = document.querySelector('[data-banner="install"]').getBoundingClientRect().top;
            const buttons = [...document.querySelectorAll("[data-day-control]")];
            const i = buttons.findIndex((b) => b.getBoundingClientRect().bottom > top);
            buttons[i - 1].focus({ preventScroll: true });
            return i;
          })()`)) as number;
          expect(covered).toBeGreaterThan(0);
          await tab.keyboard.press("Tab");
          const focused = (await tab.evaluate(`(async () => { ${FRAMES}
            await frames(2);
            const el = document.activeElement;
            return {
              index: Number(el.getAttribute("data-day-control")),
              bottom: el.getBoundingClientRect().bottom,
              sheetTop: document.querySelector('[data-banner="install"]').getBoundingClientRect().top,
            };
          })()`)) as { index: number; bottom: number; sheetTop: number };
          console.log(`${kind} ${vp.name}: Tab onto day ${focused.index} (was under the sheet): its bottom ${focused.bottom.toFixed(0)}px, sheet top ${focused.sheetTop.toFixed(0)}px`);
          expect(focused.index).toBe(covered);
          expect(focused.bottom).toBeLessThanOrEqual(focused.sheetTop);
        } finally {
          await close();
        }
      });
    }
  }
});

describe("with no advice the board is as it was (#217 AC 3)", () => {
  it("no sheet, no room reserved at the foot, and the heading runs straight into the race days", async () => {
    const { tab, shifts, close } = await openBoard(css, { width: 360, height: 640 }, null);
    try {
      const read = (await tab.evaluate(`(() => ({
        sheet: document.querySelectorAll('[data-banner="install"]').length,
        next: document.querySelector("main h1").nextElementSibling.tagName.toLowerCase(),
        bodyPadding: getComputedStyle(document.body).paddingBottom,
        scrollPadding: getComputedStyle(document.documentElement).scrollPaddingBottom,
      }))()`)) as { sheet: number; next: string; bodyPadding: string; scrollPadding: string };
      console.log(`no advice: ${JSON.stringify(read)}`);
      expect(shifts).toEqual([]);
      expect(read.sheet).toBe(0);
      expect(read.next).toBe("ol");
      // The docked navigation's own 3.5rem, and nothing for a sheet that is not there.
      expect(read.bodyPadding).toBe("56px");
      expect(read.scrollPadding).toBe("auto");
    } finally {
      await close();
    }
  });
});
