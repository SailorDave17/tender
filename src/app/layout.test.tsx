import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { generateViewport } from "./layout";
import type { ShellPerson } from "@/shell/session";

/**
 * Story #41 AC 3 — the root layout wears the club row's pair: `--brand-disc` / `--brand-mark`
 * on `<html>`, the viewport's `themeColor`, and the mark rendered inline as a component.
 * Story #154 AC 1 — and every page renders inside the one shell, with the person and the way out.
 *
 * The loader is replaced with a pair that is NOT the seed's, so that a layout which quietly fell
 * back to a constant would render the wrong colours here and go red; the claim is that whatever
 * the row holds is what the page paints. The real read is `src/brand/club-theme.ts`, proven
 * against the running app by the live probe recorded on the PR. The session read is replaced the
 * same way — `src/shell/session.ts` reaches `next/headers`, which has no request here — with a
 * person whose name is nobody's fixture, so a shell that printed a default would go red too.
 */
const ROW = { name: "Anywhere Yacht Club", disc: "#123456", mark: "#FEDCBA" };
vi.mock("@/brand/club-theme", () => ({ loadClubTheme: async () => ({ ...ROW }) }));

const PERSON: ShellPerson = { id: "p-1", email: "x@example.test", displayName: "Xenia Q", isAdmin: false };
let person: ShellPerson | null = PERSON;
vi.mock("@/shell/session", () => ({ currentPerson: async () => person }));

async function render(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: <main data-the-page /> }));
}

describe("the root layout paints the club row's pair (#41 AC 3)", () => {
  it("sets --brand-disc and --brand-mark on <html> from the row, and --bar-ink from the disc", async () => {
    const html = await render();
    // #123456 is dark: white text. The mark colour is NOT the text colour (#155's sweep, 4.13:1).
    expect(html).toMatch(/<html lang="en" style="--brand-disc:#123456;--brand-mark:#FEDCBA;--bar-ink:#FFFFFF">/);
  });

  it("chooses black text on a light disc — the ink follows the row, not a constant", async () => {
    const dark = ROW.disc;
    ROW.disc = "#FCCF0B";
    try {
      const html = await render();
      expect(html).toMatch(/--brand-disc:#FCCF0B;--brand-mark:#FEDCBA;--bar-ink:#000000"/);
    } finally {
      ROW.disc = dark;
    }
  });

  it("renders the mark inline, in the row's pair, titled with the club's name, before the page", async () => {
    const html = await render();
    // `renderToStaticMarkup` writes the bare data attribute as `="true"` (the #145 trap), so the
    // value is matched loosely.
    const bar = /<header data-brand-bar(?:="[^"]*")?>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(bar, "the brand bar renders").not.toBe("");
    expect(bar).toMatch(/<svg [^>]*data-tender-mark="primary"/);
    expect(bar).toMatch(/<title>Anywhere Yacht Club<\/title>/);
    expect(bar).toMatch(/<circle [^>]*fill="#123456"/);
    expect(bar).toMatch(/<rect [^>]*fill="#FEDCBA"/);
    expect(bar).not.toMatch(/<img\b[^>]*\bsrc=/);
    expect(html.indexOf("data-brand-bar")).toBeLessThan(html.indexOf("data-the-page"));
  });

  it("tells the browser tab the row's disc, from the same read", async () => {
    const viewport = await generateViewport();
    expect(viewport.themeColor).toBe("#123456");
    expect(viewport.width).toBe("device-width");
  });
});

describe("every page renders inside the shell (#154 AC 1)", () => {
  it("puts the page inside the frame, after the skip link and the header and before the stamp", async () => {
    person = PERSON;
    const html = await render();
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `${needle} is on the page`).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("data-skip")).toBeLessThan(at("data-brand-bar"));
    expect(at("data-brand-bar")).toBeLessThan(at('id="main"'));
    expect(at('id="main"')).toBeLessThan(at("data-the-page"));
    expect(at("data-the-page")).toBeLessThan(at("data-build-stamp"));
    expect(html).toMatch(/<a href="#main" data-skip(?:="[^"]*")?>Skip to content<\/a>/);
    expect(html).toMatch(/<div id="main" tabindex="-1" data-frame(?:="[^"]*")?><main data-the-page/);
  });

  it("names the signed-in person and offers sign-out and the navigation, with Admin only for an admin", async () => {
    person = PERSON;
    let html = await render();
    expect(html).toContain("Signed in as Xenia Q");
    expect(html).toMatch(/<form action="\/auth\/signout" method="post"><button type="submit" data-signout(?:="[^"]*")?>Sign out<\/button><\/form>/);
    for (const href of ["/board", "/post/new", "/boats", "/profile"]) expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/admin"');
    // No quote after /join: since #218 the signed-out link carries ?mode=signin, and a closed
    // quote here would no longer see it.
    expect(html).not.toContain('href="/join');

    person = { ...PERSON, isAdmin: true };
    html = await render();
    expect(html).toContain('href="/admin"');
  });

  it("falls back to the email for a person with no row, which is how a stranded account gets out", async () => {
    person = { ...PERSON, displayName: null };
    const html = await render();
    expect(html).toContain("Signed in as x@example.test");
    expect(html).toContain("data-signout");
  });

  it("shows a way in and no identity on a signed-out page", async () => {
    person = null;
    const html = await render();
    expect(html).not.toContain("Signed in as");
    expect(html).not.toContain("data-signout");
    expect(html).not.toContain('href="/board"');
    // #218: the way in names the Sign in tab; plain /join opens on Sign up for a new device.
    expect(html).toContain('href="/join?mode=signin"');
    // the mark and the skip link are there for everyone
    expect(html).toMatch(/<svg [^>]*data-tender-mark="primary"/);
    expect(html).toContain("data-skip");
  });
});

describe("Support and Privacy are under every page, signed in or out (#147 AC 3)", () => {
  /**
   * The criterion names two places — the board, and /join for someone not yet signed in — and
   * both render inside this shell, so the shell is the subject. Signed out is the arm that
   * matters most: /join is where a person who cannot get in goes looking for help.
   */
  for (const [arm, who] of [
    ["signed in", PERSON],
    ["signed out", null],
  ] as const) {
    it(`${arm}: one About nav after the page and before the stamp, linking both`, async () => {
      person = who;
      const html = await render();
      const about = html.match(/<nav aria-label="About Tender" data-about(?:="[^"]*")?>([\s\S]*?)<\/nav>/);
      expect(about, "the About nav is on the page").not.toBeNull();
      expect(html.match(/data-about/g), "exactly one").toHaveLength(1);
      expect(about![1]).toContain('href="/support"');
      expect(about![1]).toContain('href="/privacy"');
      const at = (needle: string) => html.indexOf(needle);
      expect(at("data-the-page")).toBeLessThan(at("data-about"));
      expect(at("data-about")).toBeLessThan(at("data-build-stamp"));
      // not in the member navigation, which docks to the bottom edge on a phone
      const nav = html.match(/<nav aria-label="Tender"[\s\S]*?<\/nav>/)![0];
      expect(nav).not.toContain("/support");
      expect(nav).not.toContain("/privacy");
    });
  }
});
