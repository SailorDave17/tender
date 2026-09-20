import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { generateViewport } from "./layout";

/**
 * Story #41 AC 3 — the root layout wears the club row's pair: `--brand-disc` / `--brand-mark`
 * on `<html>`, the viewport's `themeColor`, and the mark rendered inline as a component.
 *
 * The loader is replaced with a pair that is NOT the seed's, so that a layout which quietly fell
 * back to a constant would render the wrong colours here and go red; the claim is that whatever
 * the row holds is what the page paints. The real read is `src/brand/club-theme.ts`, proven
 * against the running app by the live probe recorded on the PR.
 */
const ROW = { name: "Anywhere Yacht Club", disc: "#123456", mark: "#FEDCBA" };
vi.mock("@/brand/club-theme", () => ({ loadClubTheme: async () => ROW }));

describe("the root layout paints the club row's pair (#41 AC 3)", () => {
  it("sets --brand-disc and --brand-mark on <html> from the row", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <main data-the-page /> }));
    expect(html).toMatch(/<html lang="en" style="--brand-disc:#123456;--brand-mark:#FEDCBA">/);
  });

  it("renders the mark inline, in the row's pair, titled with the club's name, before the page", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <main data-the-page /> }));
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
