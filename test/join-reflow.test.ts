import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright-core";
import { fitGoogleButton } from "@/auth/GoogleButton";
import { CHROME_CLOSE_TIMEOUT_MS } from "./chrome";
import { GLOBALS_CSS } from "./tokens";

/**
 * Story #245 — the Sign up tab fits a 360px screen at 200% text, with no sideways scroll (WCAG
 * 1.4.4 resize text, 1.4.10 reflow), read in Chrome and never from the stylesheet's text.
 *
 * Found on #226: at 360 × 780 with the root font size at 200%, `/join?mode=signup` was 483px wide
 * while Sign in fitted. The cause, measured here rather than guessed: each password box sits in a
 * flex row beside its Show button with `width: auto`, so its intrinsic width — the `size`
 * attribute's twenty characters, which grows with the text — was 401px at 200%. The fieldset's
 * user-agent `min-inline-size: min-content` and the form's grid passed that minimum up, and the
 * tabs, the invite panel and the form all ended at 483. The issue suspected the fieldset; taking
 * its minimum away alone still left the page 458px wide, because the boxes then overflow it.
 *
 * The instrument is the machine's Chrome through `playwright-core` (`channel: "chrome"`, as
 * `test/footer-streaming.test.ts` runs it), given the real `/join` rendered through the real root
 * layout with the real stylesheet inlined. Every reading on the fixed stylesheet is paired with
 * the same page with #245's rule taken out, which must scroll — otherwise 360 = 360 would be as
 * consistent with an instrument that cannot see a scroll as with a fix that works.
 *
 * With Google on, GIS never loads here, so the button is drawn by the same stand-in and the real
 * `fitGoogleButton` that `test/surfaces.test.ts` uses for #227: a box exactly as wide as asked.
 *
 * WHAT THIS CANNOT SEE: a real phone's fonts and its own text-size setting, which scales more than
 * the root font size (Android's font scale reaches the browser chrome too). The root at 200% is
 * WCAG 1.4.4's ceiling and the issue's own measurement.
 */

vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", disc: "#395FAC", mark: "#FCCF0B" }),
}));
vi.mock("@/shell/session", () => ({ currentPerson: async () => null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
}));

const css = readFileSync(GLOBALS_CSS, "utf8");

/** #245's rule, found by its selector. Exactly one, or the control arm below proves nothing. */
const RULE = /\[data-field\] input \{[^}]*\}/g;

function withoutTheRule(sheet: string): string {
  const found = sheet.match(RULE) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one #245 rule in globals.css, found ${found.length}`);
  return sheet.replace(RULE, "");
}

const CASES = ["without Google", "with Google"] as const;
type Case = (typeof CASES)[number];
const docs = new Map<Case, string>();
let browser: Browser;

beforeAll(async () => {
  const { default: RootLayout } = await import("@/app/layout");
  const { default: JoinPage } = await import("@/app/join/page");
  for (const c of CASES) {
    if (c === "with Google") vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "000000000000-reflow.apps.googleusercontent.com");
    try {
      const page = await JoinPage({ searchParams: Promise.resolve({ mode: "signup" }) });
      docs.set(c, renderToStaticMarkup(await RootLayout({ children: page })));
    } finally {
      vi.unstubAllEnvs();
    }
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, CHROME_CLOSE_TIMEOUT_MS);

function withSheet(doc: string, sheet: string): string {
  const html = `<!doctype html>${doc.replace("<body>", `<head><style>${sheet}</style></head><body>`)}`;
  if (!html.includes("<style>")) throw new Error("the layout's <body> was not found to attach the stylesheet to");
  return html;
}

const GIS = `
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
`;

type Reading = {
  scrollWidth: number;
  clientWidth: number;
  /** The fieldset's min-content width: what `min-inline-size: min-content` holds it to. */
  fieldsetMinContent: number;
  /** A password row's min-content width: the box and its Show button, as the fieldset sees them. */
  rowMinContent: number;
  /**
   * The room the page has for the form: the width of the block in `<main>` that holds the tabs and
   * the form. Not the form's or the fieldset's own width, which the defect widens with it — the
   * first version read `fieldset.parentElement` and passed with the defect back (451 ≤ 451). This
   * block stays at the page's width and its contents overflow it instead (296px at 200%).
   */
  room: number;
  google: boolean;
  passwords: number;
};

async function readJoin(c: Case, sheet: string, viewport: { width: number; height: number }, rootFont: string) {
  const context = await browser.newContext({ viewport });
  try {
    const page = await context.newPage();
    await page.setContent(withSheet(docs.get(c)!, sheet));
    await page.evaluate(`document.documentElement.style.fontSize = ${JSON.stringify(rootFont)}`);
    if (c === "with Google") {
      await page.evaluate(`(() => { ${GIS}
        for (const w of document.querySelectorAll("[data-google]")) (${fitGoogleButton.toString()})(w, w.firstElementChild, "signup_with");
      })()`);
    }
    return (await page.evaluate(`(() => {
      const minContent = (el) => {
        const was = el.style.width;
        el.style.width = "min-content";
        const w = el.getBoundingClientRect().width;
        el.style.width = was;
        return Math.round(w);
      };
      const fieldset = document.querySelector("form[data-form='signup'] fieldset");
      const row = fieldset.querySelector("[data-field] [data-row]");
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        fieldsetMinContent: minContent(fieldset),
        rowMinContent: minContent(row),
        room: Math.round(document.querySelector("main [data-stack='loose']").getBoundingClientRect().width),
        google: !!document.querySelector("[data-google] [data-gis-stub]"),
        passwords: fieldset.querySelectorAll("[data-field] input").length,
      };
    })()`)) as Reading;
  } finally {
    await context.close();
  }
}

const PHONE = { width: 360, height: 780 };

describe("the Sign up tab at 200% text on a 360px screen (#245)", () => {
  for (const c of CASES) {
    it(`${c}: no sideways scroll, and without #245's rule there is (AC 1)`, async () => {
      const fixed = await readJoin(c, css, PHONE, "200%");
      const stripped = await readJoin(c, withoutTheRule(css), PHONE, "200%");
      console.log(`#245 ${c} at 200%/360: scrollWidth ${fixed.scrollWidth} (without the rule ${stripped.scrollWidth}), clientWidth ${fixed.clientWidth}`);
      expect(fixed.google, "the Google button was drawn exactly when the case has it").toBe(c === "with Google");
      expect(fixed.passwords, "the Sign up form's two password boxes were rendered").toBe(2);
      expect(fixed.scrollWidth).toBe(fixed.clientWidth);
      expect(stripped.scrollWidth, "control: without the rule the page scrolls sideways").toBeGreaterThan(stripped.clientWidth);
    });

    it(`${c}: the password row no longer sets the fieldset's minimum width (AC 2)`, async () => {
      const fixed = await readJoin(c, css, PHONE, "200%");
      const stripped = await readJoin(c, withoutTheRule(css), PHONE, "200%");
      console.log(
        `#245 ${c} at 200%/360: password row min-content ${stripped.rowMinContent} → ${fixed.rowMinContent}px, ` +
          `fieldset min-content ${stripped.fieldsetMinContent} → ${fixed.fieldsetMinContent}px, room ${stripped.room} → ${fixed.room}px`,
      );
      // Before: the row's min-content is the box's intrinsic width, and the fieldset's follows it
      // past the room the page has. After: neither is wider than that room.
      expect(stripped.rowMinContent, "control: the box's intrinsic width").toBeGreaterThan(stripped.room);
      expect(stripped.fieldsetMinContent, "control: the fieldset held open by it").toBeGreaterThan(stripped.room);
      expect(fixed.room, "the room is the page's, whatever its contents do").toBe(stripped.room);
      expect(fixed.rowMinContent).toBeLessThanOrEqual(fixed.room);
      expect(fixed.fieldsetMinContent).toBeLessThanOrEqual(fixed.room);
    });
  }

  it("Show sits beside its box at ordinary text, and wraps under a full-width box at 200% rather than squeezing it", async () => {
    // The basis is what decides the wrap: without it the box takes no width of its own and is
    // squeezed beside Show (measured 78px at 200%), which fits the screen and nothing else.
    const layout = async (page: Page) =>
      (await page.evaluate(`(() => [...document.querySelectorAll("[data-field] [data-row]")].map((row) => {
        const box = row.querySelector("input").getBoundingClientRect();
        const show = row.querySelector("[data-toggle]").getBoundingClientRect();
        return { beside: Math.round(show.top) === Math.round(box.top), boxWidth: Math.round(box.width), rowWidth: Math.round(row.getBoundingClientRect().width) };
      }))()`)) as { beside: boolean; boxWidth: number; rowWidth: number }[];
    const at = async (rootFont: string) => {
      const context = await browser.newContext({ viewport: PHONE });
      try {
        const page = await context.newPage();
        await page.setContent(withSheet(docs.get("without Google")!, css));
        await page.evaluate(`document.documentElement.style.fontSize = ${JSON.stringify(rootFont)}`);
        return await layout(page);
      } finally {
        await context.close();
      }
    };
    const ordinary = await at("100%");
    const large = await at("200%");
    console.log(`#245 password rows at 360px: 100% ${JSON.stringify(ordinary)}; 200% ${JSON.stringify(large)}`);
    expect(ordinary).toHaveLength(2);
    for (const r of ordinary) expect(r.beside, "at 100% Show is on the box's line").toBe(true);
    for (const r of large) {
      expect(r.beside, "at 200% Show has wrapped").toBe(false);
      expect(r.boxWidth, "at 200% the box has the whole row").toBe(r.rowWidth);
    }
  });
});
