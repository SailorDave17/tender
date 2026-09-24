import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { chromium, type Browser, type Page } from "playwright-core";
import { InstallBannerView } from "@/install/InstallBanner";
import { installAdvice } from "@/install/prompt";
import { watchSheet } from "@/install/sheet";
import { watchDock } from "@/shell/dock";
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
 * THE NAV IS NOT ALWAYS 56PX. CI's first run of this file failed at 320px: on the runner's fonts
 * the docked nav wrapped to two rows (104px) and the sheet, offset by a fixed 3.5rem, sat on it.
 * *Measured* here too: 104px with the Admin link at ≤360px, 69–129px at 125% text. So the page
 * runs the real `watchDock` (`src/shell/dock.ts`), which the shell's `DockHeight` runs after
 * hydration, and the placement cases include a wrapped nav on every machine — the Admin link at
 * 320 and 360px, and 125% text — rather than relying on the runner's fonts to produce one.
 *
 * WHAT THIS CANNOT SEE: whether a real browser fires `beforeinstallprompt`, and when. That, and
 * the size the shift reaches on a throttled load, are `npm run perf:floor`'s; the reading is in
 * `docs/performance-floor.md`.
 */

const who = vi.hoisted(() => ({ admin: false }));
vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({
  currentPerson: async () => ({ id: "p-cy", email: "cy@example.test", displayName: "Cy", isAdmin: who.admin }),
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

type Viewport = { width: number; height: number };
const PHONES = [
  { name: "320×640", width: 320, height: 640 },
  { name: "360×640", width: 360, height: 640 },
  { name: "412×823 (Lighthouse mobile)", width: 412, height: 823 },
] as const;

/** Who is looking and how: a crew member at default text, then the cases where the nav wraps. */
type Case = { name: string; viewport: Viewport; admin: boolean; text: number };
const CASES: Case[] = [
  ...PHONES.map((p) => ({ name: `crew ${p.name}`, viewport: p, admin: false, text: 1 })),
  { name: "admin 320×640 (nav on two rows)", viewport: { width: 320, height: 640 }, admin: true, text: 1 },
  { name: "admin 360×640 (nav on two rows)", viewport: { width: 360, height: 640 }, admin: true, text: 1 },
  { name: "crew 360×640 at 125% text", viewport: { width: 360, height: 640 }, admin: false, text: 1.25 },
  { name: "admin 412×823 at 125% text", viewport: { width: 412, height: 823 }, admin: true, text: 1.25 },
  // The sheet taller than the stylesheet's 12rem fallback on every machine, not only on CI's fonts
  // (where the iOS wording read 244px at 125% text on 360px, over a 240px fallback).
  { name: "crew 320×640 at 150% text (sheet over the fallback)", viewport: { width: 320, height: 640 }, admin: false, text: 1.5 },
  // WCAG 1.4.4's ceiling. CI's wider fonts pushed "Not now" out of the sheet at 150% (PR #240's
  // fourth run); 200% reproduces that overflow on any machine's fonts, not only the runner's.
  { name: "crew 320×640 at 200% text (row must wrap)", viewport: { width: 320, height: 640 }, admin: false, text: 2 },
];

let browser: Browser;
const boardDocs = new Map<boolean, string>();
const banners = new Map<Kind, string>();

function withSheet(doc: string, sheet: string): string {
  const html = `<!doctype html>${doc.replace("<body>", `<head><style>${sheet}</style></head><body>`)}`;
  if (!html.includes("<style>")) throw new Error("the layout's <body> was not found to attach the stylesheet to");
  return html;
}

beforeAll(async () => {
  const { default: RootLayout } = await import("@/app/layout");
  for (const admin of [false, true]) {
    who.admin = admin;
    const doc = renderToStaticMarkup(await RootLayout({ children: boardPage() }));
    if (doc.includes('href="/admin"') !== admin) throw new Error(`the admin=${admin} render did not ${admin ? "" : "not "}carry the Admin link`);
    boardDocs.set(admin, doc);
  }
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

type Shift = { value: number; sources: string[] };
type Open = { sheet?: string; viewport: Viewport; kind: Kind | null; admin?: boolean; text?: number; watch?: boolean };

/**
 * Open the board with a layout-shift observer running and, as hydration does, the dock measured
 * and then the banner (or nothing) arriving after the heading. Returns the tab, and the shifts
 * the arrival caused.
 */
async function openBoard(o: Open): Promise<{ tab: Page; shifts: Shift[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: o.viewport });
  const tab = await context.newPage();
  await tab.setContent(withSheet(boardDocs.get(o.admin ?? false)!, o.sheet ?? css));
  if (o.text && o.text !== 1) await tab.evaluate(`document.documentElement.style.fontSize = "${o.text * 100}%"`);
  if (o.watch ?? true) await tab.evaluate(`void (${watchDock.toString()})()`);
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
    const banner = ${JSON.stringify(o.kind ? banners.get(o.kind) : "")};
    if (banner) document.querySelector("main h1").insertAdjacentHTML("afterend", banner);
    ${o.watch ?? true ? `if (banner) (${watchSheet.toString()})(document.querySelector('[data-banner="install"]'));` : ""}
    await frames(3);
    await new Promise((done) => setTimeout(done, 100));
    return shifts;
  })()`)) as Shift[];
  return { tab, shifts, close: () => context.close() };
}

const total = (shifts: Shift[]) => shifts.reduce((sum, s) => sum + s.value, 0);
const fmt = (shifts: Shift[]) =>
  `CLS ${total(shifts).toFixed(4)} [${shifts.map((s) => `${s.value.toFixed(4)} ${s.sources.join(",")}`).join("; ") || "no shifts"}]`;

describe("the banner's arrival moves nothing on the board (#217 AC 1's mechanism)", () => {
  for (const vp of PHONES) {
    for (const kind of KINDS) {
      it(`${kind} at ${vp.name}: no shift with the sheet, the list shifts without it`, async () => {
        const fixed = await openBoard({ viewport: vp, kind });
        await fixed.close();
        const control = await openBoard({ sheet: withoutTheRule(css), viewport: vp, kind });
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
  for (const c of CASES) {
    for (const kind of KINDS) {
      it(`${kind}, ${c.name}: its actions are on top and reachable, and nothing is left under it`, async () => {
        const { tab, close } = await openBoard({ viewport: c.viewport, kind, admin: c.admin, text: c.text });
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
              shadow: getComputedStyle(aside).boxShadow,
              top: rect.top, bottom: rect.bottom, height: rect.height,
              navTop: nav && getComputedStyle(nav).position === "fixed" ? nav.getBoundingClientRect().top : null,
              navHeight: nav ? nav.getBoundingClientRect().height : null,
              ceiling,
              viewport: window.innerHeight,
              overflowY: getComputedStyle(aside).overflowY,
              // "Not now" beside the wording: its top above the wording's bottom, i.e. the same row.
              dismissBeside: aside.querySelector('[data-install-action="dismiss"]').getBoundingClientRect().top < aside.querySelector("p").getBoundingClientRect().bottom,
              actions: [...aside.querySelectorAll("[data-install-action]")].map((b) => {
                // Capped at half the screen, the sheet can scroll its own wording: reach each
                // action the way a member would, by scrolling the sheet, never the page.
                const below = b.getBoundingClientRect().bottom - aside.getBoundingClientRect().bottom;
                if (below > 0) aside.scrollTop += below;
                const above = aside.getBoundingClientRect().top - b.getBoundingClientRect().top;
                if (above > 0) aside.scrollTop -= above;
                const r = b.getBoundingClientRect();
                const s = aside.getBoundingClientRect();
                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return {
                  action: b.getAttribute("data-install-action"), height: r.height, onTop: b === hit || b.contains(hit),
                  // The whole label inside the button, and the whole button inside the sheet: a
                  // centre point on top says nothing about a label clipped at the edge.
                  labelFits: b.scrollWidth <= b.clientWidth,
                  inside: r.left >= s.left && r.right <= s.right - parseFloat(getComputedStyle(aside).borderRightWidth),
                };
              }),
            };
          })()`)) as {
            position: string; shadow: string; top: number; bottom: number; height: number; navTop: number | null; navHeight: number | null; ceiling: number;
            viewport: number; overflowY: string; dismissBeside: boolean; actions: { action: string; height: number; onTop: boolean; labelFits: boolean; inside: boolean }[];
          };
          console.log(`${kind}, ${c.name}: sheet ${placed.top.toFixed(0)}–${placed.bottom.toFixed(0)}px (${placed.height.toFixed(0)} of a ${placed.ceiling}px ceiling), nav ${placed.navHeight}px at ${placed.navTop}`);

          expect(placed.position).toBe("fixed");
          expect(placed.top).toBeGreaterThanOrEqual(0);
          expect(placed.navTop, "a signed-in phone docks its navigation").not.toBeNull();
          expect(placed.bottom).toBeLessThanOrEqual(placed.navTop!);
          // Owner's review of the preview: flush on the navigation, lifted off the list by a shadow.
          expect(Math.abs(placed.bottom - placed.navTop!), "the sheet sits flush on the nav").toBeLessThan(0.5);
          expect(placed.shadow).not.toBe("none");
          // The owner approved "Not now" beside the wording. At ordinary text on a 360px phone or
          // wider it must stay there; at 320px or at large text it may wrap below (see globals.css).
          if (c.text === 1 && c.viewport.width >= 360) expect(placed.dismissBeside, '"Not now" beside the wording').toBe(true);
          // --install-sheet is the room the page makes, and it is the sheet's measured height —
          // not the 12rem fallback, which CI's fonts overran at 125% text (244px against 240).
          expect(Math.abs(placed.ceiling - placed.height)).toBeLessThan(0.5);
          // Never more than half the screen above the nav: the race days keep the other half.
          expect(placed.overflowY).toBe("auto");
          expect(placed.height).toBeLessThanOrEqual((placed.viewport - placed.navHeight!) / 2 + 0.5);
          expect(placed.actions.map((a) => a.action).sort()).toEqual(kind === "browser-prompt" ? ["dismiss", "prompt"] : ["dismiss"]);
          for (const a of placed.actions) {
            expect(a.onTop, `${a.action} is the element at its own centre`).toBe(true);
            expect(a.labelFits, `${a.action}'s label fits inside the button`).toBe(true);
            expect(a.inside, `${a.action} sits wholly inside the sheet`).toBe(true);
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
            // Start from the control before it — or, when even the first race day is under the
            // sheet (125% text on a 640px screen), from the header's sign-out, and Tab forward.
            (i > 0 ? buttons[i - 1] : document.querySelector("[data-signout]")).focus({ preventScroll: true });
            return i;
          })()`)) as number;
          expect(covered).toBeGreaterThanOrEqual(0);
          for (let presses = 0; presses < 12; presses++) {
            await tab.keyboard.press("Tab");
            if (await tab.evaluate(`document.activeElement.getAttribute("data-day-control") === "${covered}"`)) break;
          }
          const focused = (await tab.evaluate(`(async () => { ${FRAMES}
            await frames(2);
            const el = document.activeElement;
            return {
              index: Number(el.getAttribute("data-day-control")),
              bottom: el.getBoundingClientRect().bottom,
              sheetTop: document.querySelector('[data-banner="install"]').getBoundingClientRect().top,
            };
          })()`)) as { index: number; bottom: number; sheetTop: number };
          console.log(`${kind}, ${c.name}: Tab onto day ${focused.index} (was under the sheet): its bottom ${focused.bottom.toFixed(0)}px, sheet top ${focused.sheetTop.toFixed(0)}px`);
          expect(focused.index).toBe(covered);
          expect(focused.bottom).toBeLessThanOrEqual(focused.sheetTop);
        } finally {
          await close();
        }
      });
    }
  }
});

describe("the page's foot clears a wrapped navigation (#217, the dock measured)", () => {
  // The body's bottom padding was a fixed 3.5rem, so on a two-row nav the page's last lines ended
  // behind it — before #217, on every page. It now reads the measured `--dock`. The control runs
  // the same page without the measurement, and must show the stamp under the nav.
  const wrapped = { width: 320, height: 640 };
  const footOf = async (watch: boolean) => {
    const { tab, close } = await openBoard({ viewport: wrapped, kind: null, admin: true, watch });
    try {
      return (await tab.evaluate(`(async () => { ${FRAMES}
        window.scrollTo(0, document.documentElement.scrollHeight);
        await frames(2);
        const nav = document.querySelector("[data-nav][data-signed-in]").getBoundingClientRect();
        return {
          navHeight: nav.height, navTop: nav.top,
          padding: parseFloat(getComputedStyle(document.body).paddingBottom),
          stamp: document.querySelector("footer[data-build-stamp]").getBoundingClientRect().bottom,
        };
      })()`)) as { navHeight: number; navTop: number; padding: number; stamp: number };
    } finally {
      await close();
    }
  };

  it("admin at 320×640: the padding is the nav's height and the stamp ends above it; unmeasured, it does not", async () => {
    const measured = await footOf(true);
    const fallback = await footOf(false);
    console.log(`measured: ${JSON.stringify(measured)}`);
    console.log(`fallback: ${JSON.stringify(fallback)}`);
    expect(measured.navHeight).toBeGreaterThan(56);
    expect(measured.padding).toBe(measured.navHeight);
    expect(measured.stamp).toBeLessThanOrEqual(measured.navTop);
    // The control: 3.5rem under a taller nav leaves the stamp behind it.
    expect(fallback.padding).toBe(56);
    expect(fallback.stamp).toBeGreaterThan(fallback.navTop);
  });

  it("unmeasured (no script, or no ResizeObserver), a one-row nav and sheet still clear each other", async () => {
    // The stylesheet's own 3.5rem and 12rem are the fallbacks until `watchDock` and `watchSheet`
    // run. They are right for a one-row nav and a sheet of ordinary size, which is the case this
    // reads; the wrapped and enlarged cases above need the measurements.
    const { tab, close } = await openBoard({ viewport: { width: 360, height: 640 }, kind: "browser-prompt", watch: false });
    try {
      const read = (await tab.evaluate(`(() => ({
        position: getComputedStyle(document.querySelector('[data-banner="install"]')).position,
        sheetBottom: document.querySelector('[data-banner="install"]').getBoundingClientRect().bottom,
        sheetHeight: document.querySelector('[data-banner="install"]').getBoundingClientRect().height,
        room: parseFloat(getComputedStyle(document.body).paddingBottom),
        navTop: document.querySelector("[data-nav][data-signed-in]").getBoundingClientRect().top,
        navHeight: document.querySelector("[data-nav][data-signed-in]").getBoundingClientRect().height,
        inline: ["--dock", "--install-sheet"].map((p) => document.documentElement.style.getPropertyValue(p)).join(""),
      }))()`)) as { position: string; sheetBottom: number; sheetHeight: number; room: number; navTop: number; navHeight: number; inline: string };
      console.log(`unmeasured: ${JSON.stringify(read)}`);
      expect(read.inline, "neither measurement ran").toBe("");
      expect(read.position).toBe("fixed");
      expect(read.sheetBottom).toBeLessThanOrEqual(read.navTop);
      // The 12rem fallback covers a one-row sheet: the room made is at least the sheet and the nav.
      expect(read.room).toBeGreaterThanOrEqual(read.sheetHeight + read.navHeight);
    } finally {
      await close();
    }
  });

  it("on a wide screen the nav is not docked, and the measurement leaves nothing behind", async () => {
    const { tab, close } = await openBoard({ viewport: { width: 1024, height: 768 }, kind: null });
    try {
      const read = (await tab.evaluate(`(() => ({
        inline: document.documentElement.style.getPropertyValue("--dock"),
        padding: getComputedStyle(document.body).paddingBottom,
      }))()`)) as { inline: string; padding: string };
      expect(read.inline).toBe("");
      expect(read.padding).toBe("0px");
    } finally {
      await close();
    }
  });
});

describe("with no advice the board is as it was (#217 AC 3)", () => {
  it("no sheet, no room reserved at the foot, and the heading runs straight into the race days", async () => {
    const { tab, shifts, close } = await openBoard({ viewport: { width: 360, height: 640 }, kind: null });
    try {
      const read = (await tab.evaluate(`(() => ({
        sheet: document.querySelectorAll('[data-banner="install"]').length,
        next: document.querySelector("main h1").nextElementSibling.tagName.toLowerCase(),
        bodyPadding: getComputedStyle(document.body).paddingBottom,
        navHeight: document.querySelector("[data-nav][data-signed-in]").getBoundingClientRect().height,
        scrollPadding: getComputedStyle(document.documentElement).scrollPaddingBottom,
      }))()`)) as { sheet: number; next: string; bodyPadding: string; navHeight: number; scrollPadding: string };
      console.log(`no advice: ${JSON.stringify(read)}`);
      expect(shifts).toEqual([]);
      expect(read.sheet).toBe(0);
      expect(read.next).toBe("ol");
      // The docked navigation's own height, and nothing for a sheet that is not there.
      expect(read.bodyPadding).toBe(`${read.navHeight}px`);
      expect(read.scrollPadding).toBe("auto");
    } finally {
      await close();
    }
  });
});
