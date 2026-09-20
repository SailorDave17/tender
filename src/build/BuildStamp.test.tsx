import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout from "@/app/layout";
import { HOOVER_SAILING_CLUB } from "@/brand/theme";
import { BuildStamp } from "./BuildStamp";

/**
 * #169 AC 1 and the rendered half of AC 5. The footer is rendered from explicit stamps here — the
 * component's default reads the inlined values, which vitest does not set — and once through the
 * root layout, which is the mechanism by which "any page" carries it.
 *
 * Since #41 the root layout reads the club's pair from the database on every request through a
 * `server-only` module, so the loader is replaced here with a fixed pair: this file's claim is
 * about where the footer sits, and `src/app/layout.test.tsx` is where the theming is asserted.
 */
vi.mock("@/brand/club-theme", () => ({
  loadClubTheme: async () => ({ name: "Hoover Sailing Club", ...HOOVER_SAILING_CLUB }),
}));
const FULL = { version: "0.1.0", sha: "3c7759e", ref: "feature/169-build-stamp", builtAt: "2026-09-19T14:03:22.000Z" };

/** The text inside `<span data-x>`, or undefined when the span is absent. */
function part(html: string, attr: string): string | undefined {
  return new RegExp(`<span ${attr}(?:="[^"]*")?>([^<]*)</span>`).exec(html)?.[1];
}

describe("the build stamp footer (#169)", () => {
  it("prints version, commit, branch and build date, in that order, inside a footer", () => {
    const html = renderToStaticMarkup(<BuildStamp stamp={FULL} />);
    expect(html).toMatch(/^<footer [^>]*data-build-stamp/);
    expect(part(html, "data-build-version")).toBe("v0.1.0");
    expect(part(html, "data-build-sha")).toBe("3c7759e");
    expect(part(html, "data-build-ref")).toBe("feature/169-build-stamp");
    expect(html).toMatch(/<time dateTime="2026-09-19T14:03:22\.000Z">2026-09-19<\/time>/);
    const order = ["data-build-version", "data-build-sha", "data-build-ref", "<time"].map((s) => html.indexOf(s));
    expect(order, "each part after the one before it").toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain("unstamped");
  });

  it("drops the branch on release and the commit when there is none, and keeps the rest", () => {
    const prod = renderToStaticMarkup(<BuildStamp stamp={{ ...FULL, ref: "release" }} />);
    expect(part(prod, "data-build-ref")).toBeUndefined();
    expect(part(prod, "data-build-sha")).toBe("3c7759e");
    expect(prod).not.toContain("release");

    const noSha = renderToStaticMarkup(<BuildStamp stamp={{ ...FULL, sha: null }} />);
    expect(part(noSha, "data-build-sha")).toBeUndefined();
    expect(part(noSha, "data-build-version")).toBe("v0.1.0");
    expect(noSha).not.toContain("null");
    expect(noSha).not.toContain(" ·  · ");
  });

  it("says in words that a build is unstamped, rather than rendering an empty footer", () => {
    const html = renderToStaticMarkup(<BuildStamp stamp={{ version: null, sha: null, ref: null, builtAt: null }} />);
    expect(html).toContain("data-build-unstamped");
    expect(html).toContain("unstamped build");
    expect(part(html, "data-build-version")).toBeUndefined();
    expect(html).not.toContain("<time");
  });

  it("is rendered by the root layout, after the page, so every page carries it (AC 1)", async () => {
    // The layout is an async Server Component since #41; awaiting it yields the plain tree.
    const html = renderToStaticMarkup(await RootLayout({ children: <main data-the-page>hello</main> }));
    expect(html).toContain("data-the-page");
    expect(html).toContain("data-build-stamp");
    expect(html.indexOf("data-the-page")).toBeLessThan(html.indexOf("data-build-stamp"));
  });
});
