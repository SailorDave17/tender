import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchPanel } from "./MatchPanel";
import { counterpartyOf, explainAcceptRefusal, matchRole } from "./match-view";

/**
 * Story #21 AC 5: after a match, either party sees the other's name, email and phone and the
 * word 'Matched'; everyone else sees the boat crewed, with both names, and no contact. The
 * panel is handed a contact row in EVERY arm — a bystander's included, on purpose — so the
 * absence in that arm is the component withholding it, not the test never passing one.
 */

const match = { id: "m1", post_id: "p1", skipper_id: "sam", crew_id: "cy", accepted_at: "2026-08-22T12:00:00Z" };
const names = new Map([
  ["sam", "Sam"],
  ["cy", "Cy"],
]);
const CONTACT = { email: "cy@hsc-crew.org", phone: "614-555-0102" };

describe("matchRole / counterpartyOf", () => {
  it("names the skipper, the crew and everyone else, and the counterparty only for a party", () => {
    expect(matchRole(match, "sam")).toBe("skipper");
    expect(matchRole(match, "cy")).toBe("crew");
    expect(matchRole(match, "otto")).toBe("other");
    expect(counterpartyOf(match, "sam")).toBe("cy");
    expect(counterpartyOf(match, "cy")).toBe("sam");
    expect(counterpartyOf(match, "otto")).toBeNull();
  });
});

describe("MatchPanel — contact is rendered for a party only (AC 5)", () => {
  it("the skipper sees 'Matched', the crew's name, email and phone", () => {
    const html = renderToStaticMarkup(<MatchPanel match={match} viewerId="sam" names={names} contact={CONTACT} />);
    expect(html).toContain("Matched");
    expect(html).toContain("Cy");
    expect(html).toContain("cy@hsc-crew.org");
    expect(html).toContain("614-555-0102");
    expect(html).toContain('data-role="skipper"');
    expect(html).toContain('data-contact="cy"');
  });

  it("the crew sees 'Matched', the skipper's name, email and phone", () => {
    const html = renderToStaticMarkup(
      <MatchPanel match={match} viewerId="cy" names={names} contact={{ email: "sam@hsc-crew.org", phone: "614-555-0101" }} />,
    );
    expect(html).toContain("Matched");
    expect(html).toContain("Sam");
    expect(html).toContain("sam@hsc-crew.org");
    expect(html).toContain("614-555-0101");
    expect(html).toContain('data-role="crew"');
  });

  it("a bystander sees 'Crewed' with both names and no email or phone, though handed a contact row", () => {
    const html = renderToStaticMarkup(<MatchPanel match={match} viewerId="otto" names={names} contact={CONTACT} />);
    expect(html).toContain("Crewed");
    expect(html).toContain("Sam");
    expect(html).toContain("Cy");
    expect(html).not.toContain("@");
    expect(html).not.toContain("555");
    expect(html).not.toMatch(/phone|email/i);
    expect(html).not.toContain("Matched");
    expect(html).toContain('data-role="other"');
  });

  it("a party whose counterparty gave no phone reads 'not given'; a missing row reads 'not available'", () => {
    const noPhone = renderToStaticMarkup(<MatchPanel match={match} viewerId="sam" names={names} contact={{ email: "cy@hsc-crew.org", phone: null }} />);
    expect(noPhone).toContain("not given");
    expect(noPhone).toContain("cy@hsc-crew.org");
    const noRow = renderToStaticMarkup(<MatchPanel match={match} viewerId="sam" names={names} contact={null} />);
    expect(noRow).toContain("not available");
    expect(noRow).toContain("Matched");
  });
});

describe("explainAcceptRefusal", () => {
  it("explains each reason differently and falls back for an unknown one", () => {
    const messages = ["matched", "refused"].map(explainAcceptRefusal);
    expect(new Set(messages).size).toBe(2);
    expect(messages).not.toContain(explainAcceptRefusal("else"));
  });
});
