import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { chromium, type Browser } from "playwright-core";
import { GLOBALS_CSS } from "./tokens";

/**
 * Story #211 — the footer must not shift while a page streams in, read from Chrome's own
 * layout-shift entries and never from the stylesheet's text.
 *
 * The regression #185 found: since #154's root `loading.tsx`, a route's first paint is the shell
 * with a one-line "Loading…" `<main>`, and the About links and the build stamp directly under it —
 * on the first screen. The page then streams in above them and pushes them down, and Lighthouse
 * attributes the shift to `body > footer` (CLS 0.066–0.141 from the footer alone). The fix hides
 * both while the loading state is shown, so they are laid out for the first time in their final
 * place, and a box that was not in the previous frame is not a shift.
 *
 * The instrument is the machine's Chrome through `playwright-core` (`channel: "chrome"`, as
 * `test/shell-focus.test.ts` and the smoke run it) given the real root layout and the real
 * `loading.tsx`, rendered by React with the real stylesheet inlined. "Streaming" is the swap React
 * makes when the page resolves: the fallback's `<main>` inside `#main` is replaced by the page's.
 * A `PerformanceObserver` on `layout-shift` reads what that swap did.
 *
 * Every CLS reading is paired with the same stream under the stylesheet with #211's rule taken
 * out, which must show the footer shifting — otherwise a 0 would be as consistent with an
 * observer that sees nothing as with a fix that works (cairn:
 * `prove-an-instrument-could-have-shown-the-opposite`).
 *
 * WHAT THIS CANNOT SEE: the timing. The swap here is immediate; under Lighthouse's throttling the
 * loading state is on screen for seconds, which is what made the shift large enough to score.
 * Whether a shift happens does not depend on how long the fallback was shown, but its SIZE on a
 * real run does, so the criterion's number is `npm run perf:floor`'s and is recorded in
 * `docs/performance-floor.md` (cairn: `lighthouse-cls-font-swap-and-local-measurement`).
 */

vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({
  currentPerson: async () => ({ id: "p-cy", email: "cy@example.test", displayName: "Cy", isAdmin: false }),
}));

const css = readFileSync(GLOBALS_CSS, "utf8");

/** #211's rule, found by its selector. Exactly one, or the control arm below proves nothing. */
const RULE = /#main:has\(\[data-loading\]\)[^{]*\{[^}]*\}/g;

function withoutTheRule(sheet: string): string {
  const found = sheet.match(RULE) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one #211 rule in globals.css, found ${found.length}`);
  return sheet.replace(RULE, "");
}

/** A board-shaped page: a heading and a long list, taller than any phone. */
function tallPage() {
  const h = createElement;
  const rows = Array.from({ length: 30 }, (_, i) =>
    h("li", { key: i }, h("p", null, `Race day ${i + 1}`), h("p", null, "Two boats looking for crew.")),
  );
  return h("main", null, h("h1", null, "Board"), h("ol", null, ...rows));
}

/** A page shorter than the screen, like /support. */
function shortPage() {
  const h = createElement;
  return h("main", null, h("h1", null, "Support"), h("p", null, "Write to the club."));
}

/** Lighthouse's mobile preset, and AC 2's small phone. */
const VIEWPORTS = [
  { name: "412×823 (Lighthouse mobile)", width: 412, height: 823 },
  { name: "360×640", width: 360, height: 640 },
] as const;

type Shift = { value: number; sources: string[] };
type Reading = {
  shifts: Shift[];
  cls: number;
  loadingFooterDisplay: string;
  loadingAboutDisplay: string;
  footerTop: number;
  aboutTop: number;
};

let browser: Browser;
let loadingDoc: string;
const streamed = new Map<string, string>();

function withSheet(doc: string, sheet: string): string {
  const html = `<!doctype html>${doc.replace("<body>", `<head><style>${sheet}</style></head><body>`)}`;
  if (!html.includes("<style>")) throw new Error("the layout's <body> was not found to attach the stylesheet to");
  return html;
}

beforeAll(async () => {
  const { default: RootLayout } = await import("@/app/layout");
  const { default: Loading } = await import("@/app/loading");
  loadingDoc = renderToStaticMarkup(await RootLayout({ children: createElement(Loading) }));
  streamed.set("tall", renderToStaticMarkup(tallPage()));
  streamed.set("short", renderToStaticMarkup(shortPage()));
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

/** Paint the loading state, then swap the page in the way React does, and read every shift. */
async function stream(page: "tall" | "short", sheet: string, viewport: { width: number; height: number }): Promise<Reading> {
  const context = await browser.newContext({ viewport });
  try {
    const tab = await context.newPage();
    await tab.setContent(withSheet(loadingDoc, sheet));
    return (await tab.evaluate(`(async () => {
      const frames = (n) => new Promise((done) => { const step = () => (n-- ? requestAnimationFrame(step) : done()); step(); });
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
      const loadingFooterDisplay = getComputedStyle(document.querySelector("footer[data-build-stamp]")).display;
      const loadingAboutDisplay = getComputedStyle(document.querySelector("[data-about]")).display;
      // Only the shifts the swap causes: the first paint's own entries are not the subject.
      shifts.length = 0;
      document.getElementById("main").innerHTML = ${JSON.stringify(streamed.get(page))};
      await frames(3);
      await new Promise((done) => setTimeout(done, 100));
      return {
        shifts,
        cls: shifts.reduce((sum, s) => sum + s.value, 0),
        loadingFooterDisplay,
        loadingAboutDisplay,
        footerTop: document.querySelector("footer[data-build-stamp]").getBoundingClientRect().top,
        aboutTop: document.querySelector("[data-about]").getBoundingClientRect().top,
      };
    })()`)) as Reading;
  } finally {
    await context.close();
  }
}

function print(label: string, r: Reading) {
  const detail = r.shifts.map((s) => `${s.value.toFixed(4)} ${s.sources.join(",") || "(no source)"}`).join("; ");
  console.log(`${label}: CLS ${r.cls.toFixed(4)} [${detail || "no shifts"}]`);
}

describe("while loading.tsx stands in for the page (#211 AC 3, #154 AC 6 not regressed)", () => {
  it("reads Loading… inside the shell, with the About links and the stamp not laid out", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
    try {
      const tab = await context.newPage();
      await tab.setContent(withSheet(loadingDoc, css));
      const read = (await tab.evaluate(`(() => {
        const status = document.querySelector("#main[data-frame] > main > [data-loading]");
        const r = status && status.getBoundingClientRect();
        return {
          status: status && status.textContent,
          role: status && status.getAttribute("role"),
          visible: !!r && r.height > 0 && getComputedStyle(status).visibility === "visible",
          header: !!document.querySelector("header [data-nav]"),
          footer: getComputedStyle(document.querySelector("footer[data-build-stamp]")).display,
          about: getComputedStyle(document.querySelector("[data-about]")).display,
        };
      })()`)) as { status: string | null; role: string | null; visible: boolean; header: boolean; footer: string; about: string };
      console.log(`loading state: ${JSON.stringify(read)}`);
      expect(read.status).toBe("Loading…");
      expect(read.role).toBe("status");
      expect(read.visible).toBe(true);
      expect(read.header).toBe(true);
      expect(read.footer).toBe("none");
      expect(read.about).toBe("none");
    } finally {
      await context.close();
    }
  });

  it("lays both out again once the page is in, under a short page's content and on its first screen (AC 2)", async () => {
    // The short fixture, not /join, /support or /privacy: at 360×640 those three render taller
    // than the screen (`test/surfaces.test.ts` prints 820–3,584px frames), so a viewport-tall
    // frame — #185's R2, the alternative #211 was chosen over — stretches nothing on them and
    // their check cannot see it. Measured: R2's rule added left all three green. Here it cannot.
    const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
    try {
      const tab = await context.newPage();
      const { default: RootLayout } = await import("@/app/layout");
      await tab.setContent(withSheet(renderToStaticMarkup(await RootLayout({ children: shortPage() })), css));
      const read = (await tab.evaluate(`(() => ({
        footer: getComputedStyle(document.querySelector("footer[data-build-stamp]")).display,
        about: getComputedStyle(document.querySelector("[data-about]")).display,
        frame: document.getElementById("main").getBoundingClientRect().height,
        main: document.querySelector("#main[data-frame] > main").getBoundingClientRect().height,
        aboutTop: document.querySelector("[data-about]").getBoundingClientRect().top,
        stampBottom: document.querySelector("footer[data-build-stamp]").getBoundingClientRect().bottom,
      }))()`)) as { footer: string; about: string; frame: number; main: number; aboutTop: number; stampBottom: number };
      console.log(`short page loaded at 360×640: ${JSON.stringify(read)}`);
      expect(read.footer).toBe("block");
      expect(read.about).toBe("flex");
      expect(Math.abs(read.frame - read.main)).toBeLessThan(1);
      expect(read.stampBottom).toBeLessThanOrEqual(640);
    } finally {
      await context.close();
    }
  });
});

describe("a page streaming in does not shift the footer (#211 AC 1's mechanism)", () => {
  for (const vp of VIEWPORTS) {
    for (const page of ["tall", "short"] as const) {
      it(`${page} page at ${vp.name}: no shift with the rule, a footer shift without it`, async () => {
        const fixed = await stream(page, css, vp);
        const control = await stream(page, withoutTheRule(css), vp);
        print(`${page} ${vp.name} with #211`, fixed);
        print(`${page} ${vp.name} without`, control);

        // The control: the same stream without the rule moves the footer, and Chrome says so.
        expect(control.loadingFooterDisplay).toBe("block");
        expect(control.cls).toBeGreaterThan(0);
        expect(control.shifts.some((s) => s.sources.some((n) => n.startsWith("footer[data-build-stamp]") || n.startsWith("nav[data-about]")))).toBe(true);

        // The criterion's mechanism: nothing shifts.
        expect(fixed.loadingFooterDisplay).toBe("none");
        expect(fixed.loadingAboutDisplay).toBe("none");
        expect(fixed.shifts).toEqual([]);
        // And the footer does arrive, under the page.
        expect(fixed.aboutTop).toBeGreaterThan(0);
        expect(fixed.footerTop).toBeGreaterThan(fixed.aboutTop);
        if (page === "tall") expect(fixed.aboutTop).toBeGreaterThan(vp.height);
      });
    }
  }
});
