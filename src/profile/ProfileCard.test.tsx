import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileCard, hullsText } from "./ProfileCard";

/**
 * Story #18 AC 2: a different signed-in person's view of a profile carries no phone — asserted
 * on the rendered HTML, not on a hidden attribute. The card is handed a phone in BOTH arms, so
 * the absence in the stranger's arm is the component withholding it, not the test never
 * passing one; the owner's arm is the positive control that the digits do reach the HTML when
 * they should.
 */

// rating 4 is a helm since 0011 (#69) — this fixture was 3 when 3 was the top of the scale.
const ann = { id: "ann", display_name: "Ann", rating: 4, any_hull: false, hulls: ["Thistle"] };
const PHONE = "614-555-0100";

describe("ProfileCard — phone is rendered for the owner only (AC 2)", () => {
  it("a stranger's view has no phone in the HTML at all", () => {
    const html = renderToStaticMarkup(<ProfileCard person={ann} phone={PHONE} viewerId="bo" />);
    expect(html).not.toContain(PHONE);
    expect(html).not.toContain("555");
    expect(html).not.toMatch(/phone/i);
    // and it still shows what a skipper is meant to see
    expect(html).toContain("Ann");
    expect(html).toContain("Can helm");
    expect(html).toContain("Thistle");
  });

  // #69: the fourth level has to reach a skipper's eye, not only the database — a spinnaker hand
  // whose card reads "Can helm" or "Not set" is the whole story failing silently.
  it("names a spinnaker hand as one, distinctly from a helm", () => {
    const html = renderToStaticMarkup(
      <ProfileCard person={{ ...ann, rating: 3 }} phone={PHONE} viewerId="bo" />,
    );
    expect(html).toContain("Can fly a spinnaker");
    expect(html).not.toContain("Can helm");
    expect(html).not.toContain("Not set");
  });

  it("the owner's view shows the phone (positive control)", () => {
    const html = renderToStaticMarkup(<ProfileCard person={ann} phone={PHONE} viewerId="ann" />);
    expect(html).toContain(PHONE);
  });

  it("the owner with no phone sees 'not given' rather than an empty cell", () => {
    const html = renderToStaticMarkup(<ProfileCard person={ann} phone={null} viewerId="ann" />);
    expect(html).toContain("not given");
  });

  it("reads an unrated person as 'Not set', and any hull as 'Any hull'", () => {
    const cy = { id: "cy", display_name: "Cy", rating: null, any_hull: true, hulls: [] };
    const html = renderToStaticMarkup(<ProfileCard person={cy} phone={null} viewerId="ann" />);
    expect(html).toContain("Not set");
    expect(html).toContain("Any hull");
    expect(hullsText({ any_hull: false, hulls: ["Thistle", "Windmill"] })).toBe("Thistle, Windmill");
  });
});
