import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchPanel, type StatusForm } from "./MatchPanel";
import { counterpartyOf, explainAcceptRefusal, explainStatusRefusal, isSettableStatus, matchControls, matchRole, statusLabel } from "./match-view";

/**
 * Story #21 AC 5: after a match, either party sees the other's name, email and phone and the
 * word 'Matched'; everyone else sees the boat crewed, with both names, and no contact. The
 * panel is handed a contact row in EVERY arm — a bystander's included, on purpose — so the
 * absence in that arm is the component withholding it, not the test never passing one.
 */

const match = { id: "m1", post_id: "p1", skipper_id: "sam", crew_id: "cy", accepted_at: "2026-08-22T12:00:00Z", status: "accepted" as const };
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

describe("MatchPanel — a party who deleted their account reads 'former member' (#42 AC 3)", () => {
  // 0027: the crew left; their side is null, the match stands. Handed a contact row anyway, as
  // every arm is — the page would not read one for a null counterparty, and the panel must not
  // print one for a party who is no longer there.
  const crewGone = { ...match, crew_id: null };

  it("the skipper sees 'Matched' with 'former member' and no profile link, and no contact", () => {
    const html = renderToStaticMarkup(<MatchPanel match={crewGone} viewerId="sam" names={names} contact={CONTACT} />);
    expect(html).toContain("Matched");
    expect(html).toContain("former member");
    expect(html).not.toContain("/profile/null");
    expect(html).not.toContain("Cy");
  });

  it("a bystander sees 'Crewed' with the skipper's name and 'former member'", () => {
    const html = renderToStaticMarkup(<MatchPanel match={crewGone} viewerId="otto" names={names} contact={null} />);
    expect(html).toContain("Crewed");
    expect(html).toContain("Sam is sailing with former member");
  });

  it("counterpartyOf is null for the surviving party, so the page reads no contact row", () => {
    expect(counterpartyOf(crewGone, "sam")).toBeNull();
    expect(matchRole(crewGone, "sam")).toBe("skipper");
    expect(matchRole(crewGone, "otto")).toBe("other");
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

describe("MatchPanel — the calendar link, for the two parties only (#34)", () => {
  const link = '<a href="/match/m1/race.ics" download="race.ics" data-ics-link="m1">Add to calendar</a>';

  it("the skipper and the crew each get a link to this match's race.ics", () => {
    for (const viewer of ["sam", "cy"]) {
      const html = renderToStaticMarkup(<MatchPanel match={match} viewerId={viewer} names={names} contact={CONTACT} />);
      expect(html).toContain(link);
    }
  });

  it("a bystander gets no link — the route would 404 them anyway", () => {
    const html = renderToStaticMarkup(<MatchPanel match={match} viewerId="otto" names={names} contact={CONTACT} />);
    expect(html).not.toContain("race.ics");
    expect(html).not.toContain("data-ics-link");
  });
});

describe("explainAcceptRefusal", () => {
  it("explains each reason differently and falls back for an unknown one", () => {
    const messages = ["matched", "refused"].map(explainAcceptRefusal);
    expect(new Set(messages).size).toBe(2);
    expect(messages).not.toContain(explainAcceptRefusal("else"));
  });
});

/**
 * Story #37 — what became of the match, and who gets which button. The windows are the
 * definer's (0021), restated as a pure decision over `now` so the page can hide a button the
 * database would refuse; test/match-status.test.ts holds the database's own answer.
 */
const RACE = "2027-06-13T17:00:00Z"; // 1 pm EDT
const accepted = match;
const confirmed = { ...match, status: "confirmed" as const };
const sailed = { ...match, status: "sailed" as const };
const noShow = { ...match, status: "no_show" as const };

describe("matchControls — the crew's Confirm on the race day, the skipper's outcome after the start", () => {
  it("the crew gets Confirm from 00:00 on the race day in Ohio, not the night before, and not the day after", () => {
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T03:59:59Z")).confirm).toBe(false); // 23:59:59 EDT Sat
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T04:00:00Z")).confirm).toBe(true); // 00:00 EDT Sun
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T12:00:00Z")).confirm).toBe(true);
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T18:00:00Z")).confirm).toBe(true); // after the start, still the day
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-14T04:00:00Z")).confirm).toBe(false); // Monday
  });

  it("promises 'later' only before the race day: not on it, and not after it on a match nobody closed", () => {
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-06T12:00:00Z")).confirmLater).toBe(true); // a week out
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T03:59:59Z")).confirmLater).toBe(true); // 23:59 the night before
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T04:00:00Z")).confirmLater).toBe(false); // race day: Confirm instead
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-14T12:00:00Z")).confirmLater).toBe(false); // the day after
    expect(matchControls(confirmed, RACE, "cy", new Date("2027-06-06T12:00:00Z")).confirmLater).toBe(false);
    expect(matchControls(accepted, RACE, "sam", new Date("2027-06-06T12:00:00Z")).confirmLater).toBe(false);
  });

  it("only while the match is still accepted, and never for the skipper or a bystander", () => {
    const morning = new Date("2027-06-13T12:00:00Z");
    expect(matchControls(confirmed, RACE, "cy", morning).confirm).toBe(false);
    expect(matchControls(accepted, RACE, "sam", morning).confirm).toBe(false);
    expect(matchControls(accepted, RACE, "otto", morning).confirm).toBe(false);
  });

  it("the skipper gets Sailed / Did not show only after the start, while the match is not final", () => {
    expect(matchControls(accepted, RACE, "sam", new Date("2027-06-13T17:00:00Z")).record).toBe(false); // the start itself
    expect(matchControls(accepted, RACE, "sam", new Date("2027-06-13T17:00:01Z")).record).toBe(true);
    expect(matchControls(confirmed, RACE, "sam", new Date("2027-06-13T20:00:00Z")).record).toBe(true);
    expect(matchControls(sailed, RACE, "sam", new Date("2027-06-13T20:00:00Z")).record).toBe(false);
    expect(matchControls(noShow, RACE, "sam", new Date("2027-06-13T20:00:00Z")).record).toBe(false);
    expect(matchControls(accepted, RACE, "cy", new Date("2027-06-13T20:00:00Z")).record).toBe(false);
    expect(matchControls(accepted, RACE, "otto", new Date("2027-06-13T20:00:00Z")).record).toBe(false);
  });
});

describe("statusLabel / isSettableStatus / explainStatusRefusal", () => {
  it("names the three outcomes and says nothing for accepted", () => {
    expect(statusLabel("accepted")).toBe("");
    expect(statusLabel("confirmed")).toBe("Confirmed");
    expect(statusLabel("sailed")).toBe("Sailed");
    expect(statusLabel("no_show")).toBe("Did not show");
  });

  it("accepts exactly the three settable statuses — 'accepted' is never set from a form", () => {
    expect(["confirmed", "sailed", "no_show"].every(isSettableStatus)).toBe(true);
    expect(isSettableStatus("accepted")).toBe(false);
    expect(isSettableStatus("")).toBe(false);
    expect(isSettableStatus("SAILED")).toBe(false);
  });

  it("explains the refusal and falls back for an unknown reason", () => {
    expect(explainStatusRefusal("status-refused")).toMatch(/race day/);
    expect(explainStatusRefusal("??")).toBe("That could not be saved.");
  });
});

describe("MatchPanel — the outcome is shown to everyone, the buttons to the party whose window is open (AC 3, AC 4)", () => {
  const form: StatusForm = (status, label) => <button data-set-status={status}>{label}</button>;

  it("the crew sees Confirm on the race morning, and a 'later' note before it", () => {
    const open = renderToStaticMarkup(
      <MatchPanel match={accepted} viewerId="cy" names={names} contact={CONTACT} controls={{ confirm: true, confirmLater: false, record: false }} statusForm={form} />,
    );
    expect(open).toContain('data-set-status="confirmed"');
    expect(open).toContain("Confirm I");
    expect(open).not.toContain('data-set-status="sailed"');
    const later = renderToStaticMarkup(
      <MatchPanel match={accepted} viewerId="cy" names={names} contact={CONTACT} controls={{ confirm: false, confirmLater: true, record: false }} statusForm={form} />,
    );
    expect(later).toContain("morning of the race");
    expect(later).not.toContain("data-set-status");
    // and after the race day, on a match nobody closed, no promise about a morning already gone
    const gone = renderToStaticMarkup(
      <MatchPanel match={accepted} viewerId="cy" names={names} contact={CONTACT} controls={{ confirm: false, confirmLater: false, record: false }} statusForm={form} />,
    );
    expect(gone).not.toContain("morning of the race");
  });

  it("the skipper sees Sailed and Did not show after the start, and nothing before", () => {
    const after = renderToStaticMarkup(
      <MatchPanel match={confirmed} viewerId="sam" names={names} contact={CONTACT} controls={{ confirm: false, confirmLater: false, record: true }} statusForm={form} />,
    );
    expect(after).toContain('data-set-status="sailed"');
    expect(after).toContain('data-set-status="no_show"');
    expect(after).not.toContain('data-set-status="confirmed"');
    const before = renderToStaticMarkup(<MatchPanel match={accepted} viewerId="sam" names={names} contact={CONTACT} statusForm={form} />);
    expect(before).not.toContain("data-set-status");
  });

  it("without a form renderer no button is rendered, whatever the controls say", () => {
    const html = renderToStaticMarkup(
      <MatchPanel match={accepted} viewerId="cy" names={names} contact={CONTACT} controls={{ confirm: true, confirmLater: false, record: true }} />,
    );
    expect(html).not.toContain("data-set-status");
  });

  it("a confirmed match reads 'Confirmed' to both parties, in each one's own terms", () => {
    const crew = renderToStaticMarkup(<MatchPanel match={confirmed} viewerId="cy" names={names} contact={CONTACT} />);
    expect(crew).toContain('data-match-status="confirmed"');
    expect(crew).toContain("You confirmed");
    const skipper = renderToStaticMarkup(<MatchPanel match={confirmed} viewerId="sam" names={names} contact={CONTACT} />);
    expect(skipper).toContain("Cy confirmed");
  });

  it("a no-show is shown to the crew it was recorded against — nothing is hidden from them (AC 4)", () => {
    const crew = renderToStaticMarkup(<MatchPanel match={noShow} viewerId="cy" names={names} contact={CONTACT} />);
    expect(crew).toContain('data-match-status="no_show"');
    expect(crew).toContain("Did not show");
    expect(crew).toContain("recorded a no-show against this match");
    const skipper = renderToStaticMarkup(<MatchPanel match={noShow} viewerId="sam" names={names} contact={CONTACT} />);
    expect(skipper).toContain("You recorded that Cy did not show");
    const sailedCrew = renderToStaticMarkup(<MatchPanel match={sailed} viewerId="cy" names={names} contact={CONTACT} />);
    expect(sailedCrew).toContain("recorded that you sailed");
  });

  it("a bystander sees the outcome word beside 'Crewed', and still no contact", () => {
    const html = renderToStaticMarkup(<MatchPanel match={noShow} viewerId="otto" names={names} contact={CONTACT} />);
    expect(html).toContain("Crewed");
    expect(html).toContain('data-match-status="no_show"');
    expect(html).toContain("Did not show");
    expect(html).not.toContain("@");
    expect(html).not.toContain("data-set-status");
    // and an accepted match says nothing extra — 'Crewed' already says it
    const plain = renderToStaticMarkup(<MatchPanel match={accepted} viewerId="otto" names={names} contact={CONTACT} />);
    expect(plain).toContain('data-match-status="accepted"');
    expect(plain).not.toMatch(/Confirmed|Sailed|Did not show/);
  });
});
