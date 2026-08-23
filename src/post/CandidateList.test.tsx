import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RUNG_COLOUR } from "@/board/post-view";
import { CandidateList, RungBadge, type CandidatePerson } from "./CandidateList";

/**
 * Story #19 AC 5: the skipper's list carries name, rating and hull willingness only — a test
 * asserts no email or phone in the output. The people handed in here carry BOTH, on purpose,
 * so the absence is the component withholding them and not the test never passing them.
 */

type Loaded = CandidatePerson & { email: string; phone: string };
const people = new Map<string, Loaded>([
  ["ann", { id: "ann", display_name: "Ann", rating: 3, any_hull: false, hulls: ["Thistle"], email: "ann@hsc-crew.org", phone: "614-555-0100" }],
  ["cy", { id: "cy", display_name: "Cy", rating: 2, any_hull: true, hulls: [], email: "cy@hsc-crew.org", phone: "614-555-0199" }],
]);
const rows = [
  { id: "ann", rung: 1 as const, colour: RUNG_COLOUR[1], notified: true, answered: false },
  { id: "cy", rung: 2 as const, colour: RUNG_COLOUR[2], notified: false, answered: false },
];

describe("CandidateList — name, competence and hulls only (AC 5)", () => {
  const html = renderToStaticMarkup(<CandidateList rows={rows} people={people} />);

  it("renders each crew with their rung number in text and their colour", () => {
    expect(html).toContain("Ann");
    expect(html).toContain("Can helm");
    expect(html).toContain("thistle");
    expect(html).toContain("Rung 1");
    expect(html).toContain("green");
    expect(html).toContain("Rung 2");
    expect(html).toContain("amber");
    expect(html).toContain(RUNG_COLOUR[1].hex);
  });

  it("marks a rung the post has not reached as not yet notified, and only that one", () => {
    expect(html.match(/not yet notified/g)).toHaveLength(1);
    expect(html).toContain('data-candidate="cy" data-notified="false"');
    expect(html).toContain('data-candidate="ann" data-notified="true"');
  });

  it("carries no email and no phone, though it was handed both", () => {
    expect(html).not.toContain("hsc-crew.org");
    expect(html).not.toContain("@");
    expect(html).not.toContain("555");
    expect(html).not.toMatch(/phone|email/i);
  });

  it("says so when nobody is available", () => {
    const empty = renderToStaticMarkup(<CandidateList rows={[]} people={people} />);
    expect(empty).toContain("Nobody has marked this day available yet");
    expect(empty).toContain('data-candidates="0"');
  });

  it("shows no 'answered' badge when nobody has", () => {
    expect(html).not.toContain('data-badge="answered"');
    expect(html).not.toContain(">answered<");
  });
});

describe("CandidateList — the 'answered' badge (story #20 AC 4)", () => {
  const answered = [
    { id: "cy", rung: 2 as const, colour: RUNG_COLOUR[2], notified: true, answered: true },
    { id: "ann", rung: 1 as const, colour: RUNG_COLOUR[1], notified: true, answered: false },
  ];
  const html = renderToStaticMarkup(<CandidateList rows={answered} people={people} />);

  it("badges exactly the answerer, in the order the rows came, with their rung colour and rating", () => {
    expect(html.match(/data-badge="answered"/g)).toHaveLength(1);
    expect(html).toContain('data-candidate="cy" data-notified="true" data-answered="true"');
    expect(html).toContain('data-candidate="ann" data-notified="true" data-answered="false"');
    expect(html.indexOf('data-candidate="cy"')).toBeLessThan(html.indexOf('data-candidate="ann"'));
    // The answerer's row carries rung 2 / amber and 'Can hike and trim', not the badge alone.
    const cyRow = html.slice(html.indexOf('data-candidate="cy"'), html.indexOf('data-candidate="ann"'));
    expect(cyRow).toContain("Rung 2");
    expect(cyRow).toContain(RUNG_COLOUR[2].hex);
    expect(cyRow).toContain("Can hike and trim");
    expect(cyRow).toContain(">answered<");
  });

  it("still carries no email and no phone", () => {
    expect(html).not.toContain("hsc-crew.org");
    expect(html).not.toContain("555");
  });
});

describe("RungBadge — never colour alone", () => {
  it("prints the number and the colour's name as text", () => {
    const html = renderToStaticMarkup(<RungBadge rung={3} colour={RUNG_COLOUR[3]} />);
    expect(html).toContain("Rung 3");
    expect(html).toContain("red");
    expect(html).toContain('data-rung="3"');
  });
});

describe("CandidateList — the Accept slot renders for answered rows only (story #21)", () => {
  const mixed = [
    { id: "cy", rung: 2 as const, colour: RUNG_COLOUR[2], notified: true, answered: true },
    { id: "ann", rung: 1 as const, colour: RUNG_COLOUR[1], notified: true, answered: false },
  ];
  const accept = (id: string) => <button data-accept={id}>Accept</button>;

  it("offers Accept beside the answerer and not beside the crew who has not answered", () => {
    const html = renderToStaticMarkup(<CandidateList rows={mixed} people={people} accept={accept} />);
    expect(html.match(/data-accept="/g)).toHaveLength(1);
    expect(html).toContain('data-accept="cy"');
    expect(html).not.toContain('data-accept="ann"');
    const cyRow = html.slice(html.indexOf('data-candidate="cy"'), html.indexOf('data-candidate="ann"'));
    expect(cyRow).toContain(">Accept<");
  });

  it("renders no Accept at all when no slot is given", () => {
    const html = renderToStaticMarkup(<CandidateList rows={mixed} people={people} />);
    expect(html).not.toContain("Accept");
  });
});
