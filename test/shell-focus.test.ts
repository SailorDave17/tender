import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright-core";
import { createElement } from "react";
import { CHROME_CLOSE_TIMEOUT_MS } from "./chrome";
import { GLOBALS_CSS } from "./tokens";

/**
 * Story #154 AC 4 and AC 5 — the keyboard and the thumb, read from Chrome and never from token
 * arithmetic.
 *
 * AC 4: Tab from the top lands on the skip link first, and every stop after it shows a ring whose
 * colour clears 3:1 against the surface around it — `getComputedStyle(el).outlineColor` after a
 * REAL Tab press (programmatic `focus()` does not reliably match `:focus-visible`), the adjacent
 * surface found by walking up to the first ancestor with an opaque background, the WCAG ratio
 * computed from the two `rgb()` strings. The ring colour and the ratio are PRINTED for every stop,
 * pass or fail: a verdict-only instrument cannot show a regression inside the passing band
 * (cairn: `a-lint-preset-can-omit-the-rule-a-criterion-names`, the second instance).
 *
 * AC 5: at 390 CSS px every target on the page is at least 44×44, and the navigation — with
 * "Post", the board's primary action — sits docked to the bottom edge of the viewport.
 *
 * The page is the real root layout, rendered by React with the real stylesheet inlined and a
 * fixture `<main>` carrying one of every control a surface uses. Signed in as an admin, so every
 * navigation item exists. The club loader and the session are mocked the way `layout.test.tsx`
 * mocks them; the row's pair is Hoover's, because the brand bar's ring is `--brand-mark` and the
 * claim there is 0028's (3:1 at save), read here on the real pair.
 *
 * WHAT THIS CANNOT SEE: the surfaces' own controls on the real pages — inline links in prose, the
 * availability toggles, the Accept button. Those are #155's, on its restyled pages. This proves
 * the shell and the base element rules.
 */

vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({
  currentPerson: async () => ({ id: "p-1", email: "a@example.test", displayName: "Ada", isAdmin: true }),
}));
// #242: the screen the page is on, as `NavLinks` reads it. Null for the page the tests above
// build, which is no screen at all and marks no tab; `pageAt` below sets it per render.
let pathname: string | null = null;
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => pathname,
}));

const css = readFileSync(GLOBALS_CSS, "utf8");

/** One of every control kind, inside a card and on the page, the way a surface would use them. */
function fixturePage() {
  const h = createElement;
  return h(
    "main",
    null,
    h("h1", null, "Fixture"),
    h("p", null, "A sentence with ", h("a", { href: "/inline", "data-inline": "" }, "an inline link"), " in it."),
    h("p", null, h("button", { type: "button" }, "A button")),
    h("p", null, h("label", null, "A text box ", h("input", { type: "text", name: "t" }))),
    h("p", null, h("label", null, "A choice ", h("select", { name: "s" }, h("option", null, "one")))),
    h("p", null, h("label", null, "Notes ", h("textarea", { name: "n" }))),
    h("p", null, h("label", { "data-box": "" }, h("input", { type: "checkbox", name: "c" }), " A box")),
    h(
      "div",
      { style: { background: "var(--surface)", padding: "8px" }, "data-card": "" },
      h("a", { href: "/card", "data-card-link": "" }, "A link on a card"),
    ),
    h(
      "div",
      { style: { background: "var(--accent-soft)", padding: "8px" }, "data-soft": "" },
      h("a", { href: "/soft", "data-soft-link": "" }, "A link on a highlighted row"),
    ),
  );
}

type Stop = {
  label: string;
  ring: string;
  style: string;
  width: string;
  surface: string;
  ratio: number;
  onBrandBar: boolean;
  rect: { width: number; height: number; top: number; bottom: number };
  inline: boolean;
};

let browser: Browser;
let html: string;

/** The real root layout around the fixture page, as `path` would render it, stylesheet inlined. */
async function pageAt(path: string | null): Promise<string> {
  pathname = path;
  const { default: RootLayout } = await import("@/app/layout");
  const doc = renderToStaticMarkup(await RootLayout({ children: fixturePage() }));
  // the layout renders no <head> (Next adds it), so the stylesheet goes in one here
  const out = `<!doctype html>${doc.replace("<body>", `<head><style>${css}</style></head><body>`)}`;
  if (!out.includes("<style>")) throw new Error("the layout's <body> was not found to attach the stylesheet to");
  return out;
}

beforeAll(async () => {
  html = await pageAt(null);
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, CHROME_CLOSE_TIMEOUT_MS);

/** The WCAG ratio between two `rgb(r, g, b)` strings, computed in the page. */
const IN_PAGE = `
  const lum = (s) => {
    const [r, g, b] = s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number);
    const ch = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const opaque = (s) => s && s !== "transparent" && !/rgba\\([^)]*,\\s*0\\)$/.test(s);
  const surfaceOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (opaque(bg)) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
`;

async function tabThrough(viewport: { width: number; height: number }, scheme: "light" | "dark"): Promise<Stop[]> {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    const stops: Stop[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(`(() => { ${IN_PAGE}
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const label = (el.getAttribute("data-skip") !== null ? "skip link" : el.tagName.toLowerCase() + (el.textContent.trim() ? " " + JSON.stringify(el.textContent.trim().slice(0, 24)) : " " + (el.getAttribute("name") || el.getAttribute("type") || "")));
        const surface = surfaceOf(el);
        const target = el.matches("input[type=checkbox],input[type=radio]") ? el.closest("label") ?? el : el;
        const r = target.getBoundingClientRect();
        return {
          label,
          ring: cs.outlineColor, style: cs.outlineStyle, width: cs.outlineWidth,
          surface, ratio: ratio(cs.outlineColor, surface),
          onBrandBar: !!el.closest("[data-brand-bar]"),
          rect: { width: r.width, height: r.height, top: r.top, bottom: r.bottom },
          // WCAG 2.5.5's inline exception, decided by what the browser computed and not by a
          // fixture attribute: a link laid out inline in text is not held to 44px.
          inline: el.tagName === "A" && cs.display === "inline",
        };
      })()`) as Stop | null;
      if (!stop) break;
      const key = `${stop.label}|${stop.rect.top}`;
      if (seen.has(key)) break;
      seen.add(key);
      stops.push(stop);
    }
    return stops;
  } finally {
    await context.close();
  }
}

describe("Tab from the top: the skip link first, then a 3:1 ring on every stop (#154 AC 4)", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: every stop's ring, printed`, async () => {
      const stops = await tabThrough({ width: 1024, height: 800 }, scheme);
      expect(stops.length, "the page has stops").toBeGreaterThan(8);
      expect(stops[0].label).toBe("skip link");
      for (const s of stops) {
        console.log(
          `${scheme.padEnd(5)} ${s.label.padEnd(26)} ring ${s.ring.padEnd(18)} on ${s.surface.padEnd(18)} ${s.ratio.toFixed(2)}:1${s.onBrandBar ? "  (brand bar: --brand-mark)" : ""}`,
        );
        expect(s.style, `${s.label} has a ring`).not.toBe("none");
        expect(parseFloat(s.width), `${s.label} ring width`).toBeGreaterThanOrEqual(2);
        expect(s.ratio, `${scheme}: ${s.label} ring ${s.ring} on ${s.surface}`).toBeGreaterThanOrEqual(3);
      }
      // the brand bar's stops really are on the disc, and the ring there is the club's mark
      const bar = stops.filter((s) => s.onBrandBar);
      expect(bar.length).toBeGreaterThanOrEqual(6); // home, sign out, Board, Post, Boats, Profile, Admin
      for (const s of bar) expect(s.ring).toBe("rgb(252, 207, 11)");
      // and at least one stop sits on each of the three surfaces the pairings promise
      expect(stops.some((s) => s.label.includes("card"))).toBe(true);
      expect(stops.some((s) => s.label.includes("highlighted"))).toBe(true);
    });
  }
});

describe("a phone at 390px: 44×44 targets and the navigation within thumb reach (#154 AC 5)", () => {
  it("every target is at least 44 CSS px each way, printed; inline prose links are the stated exception", async () => {
    const stops = await tabThrough({ width: 390, height: 800 }, "light");
    expect(stops[0].label).toBe("skip link");
    for (const s of stops) {
      console.log(`390px ${s.label.padEnd(26)} ${s.rect.width.toFixed(0)}×${s.rect.height.toFixed(0)}${s.inline ? "  (inline link — WCAG 2.5.5 exception)" : ""}`);
      if (s.inline) continue;
      expect(s.rect.width, `${s.label} width`).toBeGreaterThanOrEqual(44);
      expect(s.rect.height, `${s.label} height`).toBeGreaterThanOrEqual(44);
    }
    // The exemption covers exactly the fixture's three text links and nothing in the shell: a nav
    // link that fell back to inline would appear here and fail the assertion below.
    expect(stops.filter((s) => s.inline).map((s) => s.label)).toEqual([
      'a "an inline link"',
      'a "A link on a card"',
      'a "A link on a highlighted "',
    ]);
    expect(stops.filter((s) => s.onBrandBar && s.inline)).toEqual([]);
  });

  it("the navigation is docked to the bottom edge, with Post in it", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    try {
      const page = await context.newPage();
      await page.setContent(html);
      const read = (await page.evaluate(`(() => {
        const nav = document.querySelector("[data-nav]");
        const r = nav.getBoundingClientRect();
        const post = [...nav.querySelectorAll("a")].find((a) => a.textContent.trim() === "Post");
        const p = post.getBoundingClientRect();
        return { position: getComputedStyle(nav).position, top: r.top, bottom: r.bottom, inner: window.innerHeight,
                 postText: post.textContent.trim(), postBottom: p.bottom, postHeight: p.height };
      })()`)) as { position: string; top: number; bottom: number; inner: number; postText: string; postBottom: number; postHeight: number };
      console.log(`390px nav: ${read.position} top ${read.top.toFixed(0)} bottom ${read.bottom.toFixed(0)} of ${read.inner}; Post bottom ${read.postBottom.toFixed(0)}`);
      expect(read.position).toBe("fixed");
      expect(read.bottom).toBeCloseTo(read.inner, 0);
      expect(read.top).toBeGreaterThan(read.inner - 120);
      expect(read.postText).toBe("Post");
      expect(read.postHeight).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  it("…and not on a wider screen, where it sits in the header", async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    try {
      const page = await context.newPage();
      await page.setContent(html);
      const read = (await page.evaluate(`(() => {
        const nav = document.querySelector("[data-nav]");
        return { position: getComputedStyle(nav).position, top: nav.getBoundingClientRect().top };
      })()`)) as { position: string; top: number };
      expect(read.position).not.toBe("fixed");
      expect(read.top).toBeLessThan(120);
    } finally {
      await context.close();
    }
  });
});

type TabRead = { label: string; current: boolean; border: string; x: number; width: number; height: number };

/** Each nav link's computed top border and its box, read in Chrome on the page as `path` renders it. */
async function readTabs(path: string | null, viewport: { width: number; height: number }): Promise<{ tabs: TabRead[]; navHeight: number }> {
  const doc = await pageAt(path);
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    await page.setContent(doc);
    return (await page.evaluate(`(() => {
      const nav = document.querySelector("[data-nav]");
      const tabs = [...nav.querySelectorAll("a")].map((a) => {
        const cs = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        return { label: a.textContent.trim(), current: a.getAttribute("aria-current") === "page",
                 border: cs.borderTopStyle + " " + cs.borderTopWidth, x: r.x, width: r.width, height: r.height };
      });
      return { tabs, navHeight: nav.getBoundingClientRect().height };
    })()`)) as { tabs: TabRead[]; navHeight: number };
  } finally {
    await context.close();
  }
}

/**
 * #242 AC 3 — Post carries no outline off /post/new; the outline marks the current screen's tab.
 * Read as the COMPUTED border in Chrome with the real stylesheet, because the defect was a rule
 * (`[data-nav] a[data-primary]`), and a markup assertion cannot see a rule that still matches.
 * And the mark moving must not move the dock: every tab's box is the same whichever is marked.
 */
describe("the outline marks the current tab, and Post only on /post/new (#242 AC 3)", () => {
  for (const viewport of [{ width: 390, height: 800 }, { width: 1024, height: 800 }]) {
    it(`${viewport.width}px: only the marked tab has a border, and Post has none on /board`, async () => {
      const board = await readTabs("/board", viewport);
      const post = await readTabs("/post/new", viewport);
      for (const [name, read, marked] of [["/board", board, "Board"], ["/post/new", post, "Post"]] as const) {
        console.log(`${viewport.width}px ${name}: ${read.tabs.map((t) => `${t.label} ${t.border}`).join(" · ")}`);
        expect(read.tabs.filter((t) => t.current).map((t) => t.label)).toEqual([marked]);
        for (const t of read.tabs) {
          expect(t.border, `${name}: ${t.label}`).toBe(t.label === marked ? "solid 2px" : "none 0px");
        }
      }
      // The criterion in its own words: Post, on a screen that is not /post/new, has no outline.
      expect(board.tabs.find((t) => t.label === "Post")?.border).toBe("none 0px");
    });

    it(`${viewport.width}px: the tabs keep their size and place as the mark moves`, async () => {
      const [board, post, none] = [
        await readTabs("/board", viewport),
        await readTabs("/post/new", viewport),
        await readTabs("/welcome", viewport),
      ];
      expect(none.tabs.filter((t) => t.current)).toEqual([]);
      const boxes = (r: { tabs: TabRead[] }) => r.tabs.map(({ label, x, width, height }) => ({ label, x, width, height }));
      expect(boxes(post)).toEqual(boxes(board));
      expect(boxes(none)).toEqual(boxes(board));
      expect(post.navHeight).toBe(board.navHeight);
      expect(none.navHeight).toBe(board.navHeight);
      // and a marked tab is still a 44px target
      for (const t of board.tabs) expect(t.height, t.label).toBeGreaterThanOrEqual(44);
    });
  }
});
