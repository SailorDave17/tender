import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ATTEMPT_WINDOW_MS } from "@/auth/attempt-limit";
import PrivacyPage from "./page";

/**
 * #147 AC 2 — /privacy says what Tender keeps, who can see it, and what deletion does.
 *
 * What this can and cannot prove. It holds the page to its STRUCTURE and to the sentences most
 * likely to be dropped in a later edit — the ones where the schema says more than a member would
 * guess, and where leaving them out would make the page read kinder than the database is: the club
 * admin reads every thread (0023), a match partner keeps your contact details after the race
 * (0008 has no time bound), and deletion KEEPS four things (0027). It cannot prove any sentence
 * true — that was checked by reading the migrations, claim by claim, and the PR for #147 records
 * each source. A migration that changes who can read something leaves this file green.
 */
const html = renderToStaticMarkup(PrivacyPage());

function section(name: string): string {
  const start = html.indexOf(`<section data-section="${name}">`);
  expect(start, `the ${name} section is on the page`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("/privacy (#147 AC 2)", () => {
  it("has the six sections a member looks for, in order", () => {
    const order = ["holds", "who-sees", "services", "delete", "copy", "adults"].map((s) =>
      html.indexOf(`data-section="${s}"`),
    );
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("says the club admin can read every match thread — 0023, which the charter does not mention", () => {
    expect(section("who-sees")).toContain("and by the club admin, who can read any thread in order to moderate it");
  });

  it("says who sees contact details: the pair, after the race too, and no other screen", () => {
    const who = section("who-sees");
    expect(who).toContain("the two of you can see each other&#x27;s, and still can after the race");
    expect(who).toContain("No other Tender screen shows them, the club admin&#x27;s included.");
  });

  it("names the one thing a signed-out visitor does see: the admin's address on /support", () => {
    expect(section("who-sees")).toContain("The one exception is the club admin&#x27;s contact address");
  });

  it("names the guessing record, what is kept of it and for how long (#206, 0032)", () => {
    // 0032 stores digests of the source address and the named email for one window. The page must
    // say that a record exists, that it is not the address itself, and when it goes — the three
    // things a later change to the window or the keys would make false.
    const holds = section("holds");
    expect(holds).toMatch(/data-claim="attempts"/);
    expect(holds).toMatch(/cannot be turned back into either/);
    // Derived, not restated: the page's number is a copy of the constant, so a new window reddens here.
    expect(holds).toContain(`after ${ATTEMPT_WINDOW_MS / 60_000} minutes`);
  });

  it("says what deletion keeps, not only what it removes", () => {
    const del = section("delete");
    const kept = del.slice(del.indexOf("<ul data-kept"), del.indexOf("</ul>", del.indexOf("<ul data-kept")));
    expect(kept.match(/<li>/g)).toHaveLength(4);
    expect(kept).toContain("a match with your side blank");
    expect(kept).toContain("with no owner");
    expect(kept).toContain("crew needs you posted stay, notes included");
    // The device address went with #197 (0029): a push row's provider_id is the device's endpoint.
    expect(kept).toContain("without your name, your email address or your device&#x27;s notification address");
  });

  it("names every outside service the charter's stack and integrations list", () => {
    const services = section("services");
    for (const name of ["Supabase", "Vercel", "Resend", "Google", "Apple, Google or Mozilla"]) {
      expect(services, name).toContain(`<strong>${name}</strong>`);
    }
  });

  it("sends questions, copies and deletion requests to /support", () => {
    expect(html).toContain('href="/support"');
    expect(section("copy")).toContain("Support page");
    expect(section("delete")).toContain("Support page");
  });
});
