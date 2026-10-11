import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupportContact } from "@/support/contact-read";

/**
 * #147 AC 1 — /support names a contact email, an expected response time, and the known issues.
 *
 * The address comes from `src/support/contact.ts`, which reads the club row as the service role
 * and imports `server-only` — unresolvable under vitest, and a suite that reaches it dies at
 * import with its tests leaving the total (the overlay's #41(b)). So the loader is replaced here,
 * with an address that is nobody's fixture: a page that printed a default would go red. That the
 * real loader reads the real row is the smoke's claim, against a stack (`scripts/smoke.mjs`), and
 * what the real loader does with a REFUSED read is `src/support/contact-fallback.test.tsx`'s (#204).
 */
let contact: SupportContact = { kind: "address", address: "someone@club.example.test" };
vi.mock("@/support/contact", () => ({ loadSupportAddress: async () => contact }));

async function render(): Promise<string> {
  const { default: SupportPage } = await import("./page");
  return renderToStaticMarkup(await SupportPage());
}

describe("/support (#147 AC 1)", () => {
  it("names the club's address as a mailto link, and promises a reply within two days", async () => {
    contact = { kind: "address", address: "someone@club.example.test" };
    const html = await render();
    expect(html).toContain('<a href="mailto:someone@club.example.test">someone@club.example.test</a>');
    expect(html).toMatch(/<p data-response-time(?:="[^"]*")?>You should hear back within two days\.<\/p>/);
    expect(html).not.toContain('data-contact="none"');
    expect(html).not.toContain('data-contact="unreadable"');
  });

  it("with no address on the row, says who to ask instead and promises nothing", async () => {
    // 0009 made admin_email nullable on purpose; the page must not render an empty mailto.
    contact = { kind: "none" };
    const html = await render();
    expect(html).toContain('data-contact="none"');
    expect(html).toContain("Ask whoever gave you the club&#x27;s invite code.");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("data-response-time");
    expect(html).not.toContain('data-contact="unreadable"');
  });

  it("when the address could not be read, says so and to reload — not that the club has none (#204)", async () => {
    // The club HAS an address; this request could not see it. The no-address sentence would tell
    // the reader to stop looking, which is why the refusal has one of its own.
    contact = { kind: "unreadable" };
    const html = await render();
    expect(html).toContain('data-contact="unreadable"');
    expect(html).toContain("The club&#x27;s contact address could not be loaded just now. Reload this page in a moment");
    expect(html).not.toContain('data-contact="none"');
    expect(html).not.toContain("has not given Tender a contact address");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("data-response-time");
  });

  it("lists the two standing known issues, each in words a member can act on", async () => {
    contact = { kind: "address", address: "someone@club.example.test" };
    const html = await render();
    const list = html.slice(html.indexOf("<ul data-known-issues"), html.indexOf("</ul>", html.indexOf("<ul data-known-issues")));
    expect(list.match(/<li>/g)).toHaveLength(2);
    // iPhone push: the install banner's own steps, so the two places cannot teach different taps
    expect(list).toContain("On an iPhone, notifications need Tender on your home screen.");
    expect(list).toContain("<strong>Share</strong> at the bottom of Safari, then <strong>Add to Home Screen</strong>");
    // the daily cap: skipped, not delayed — and where to look instead
    expect(list).toContain("Tender can send about 100 emails a day.");
    expect(list).toContain("skipped rather than sent late");
  });

  it("links to /privacy", async () => {
    const html = await render();
    expect(html).toContain('href="/privacy"');
  });
});
