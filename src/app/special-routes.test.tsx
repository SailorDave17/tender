import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Loading from "./loading";
import NotFound from "./not-found";
import RouteError from "./error";

/**
 * Story #154 AC 6 — a slow, throwing or missing route shows a sentence, not a bare browser page.
 * Next mounts each of these in place of the page's `<main>` inside the root layout, so the shell
 * around them is `layout.test.tsx`'s claim; this one is that each carries a stated message and,
 * where there is one, a way back. `error.tsx` is a client component and renders statically like
 * any other. WHAT THIS CANNOT SEE: whether its button calls `reset` — a static render fires no
 * click, and a button that did nothing would render identically. That wiring is one line in the
 * component and is not claimed here.
 */
describe("the special routes say what happened (#154 AC 6)", () => {
  it("loading: a status line", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toMatch(/^<main>/);
    expect(html).toMatch(/<p role="status" data-loading(?:="[^"]*")?>Loading…<\/p>/);
  });

  it("not-found: a heading, a sentence that covers both readings, and the way back", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toMatch(/^<main data-not-found/);
    expect(html).toContain("<h1>Not here</h1>");
    expect(html).toContain("That page does not exist, or it is not one you can see.");
    expect(html).toContain('href="/board"');
  });

  it("error: an alert, a try-again button, and the way back — never the exception's own text", () => {
    const html = renderToStaticMarkup(<RouteError error={new Error("boom")} reset={() => undefined} />);
    expect(html).toMatch(/^<main data-route-error/);
    expect(html).toMatch(/<p role="alert">That did not work on our side\. The club admin has been told\.<\/p>/);
    expect(html).toContain('href="/board"');
    // never the exception's own text: a stack or a database message is not for a member
    expect(html).not.toContain("boom");
    expect(html).toMatch(/<button type="button">Try again<\/button>/);
  });
});
