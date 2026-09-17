import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchPanel } from "./MatchPanel";
import { MESSAGE_BODY_MAX, THREAD_CLOSED_NOTE, explainMessageRefusal, threadIsOpen } from "./thread-view";

/**
 * Story #35's rendered surfaces (AC 2, AC 5), using `renderToStaticMarkup` — the instrument
 * MatchPanel.test.tsx and sign-in-screens.test.tsx already establish here.
 *
 * WHY THIS FILE EXISTS: a review found that nothing rendered any of #35's UI. The page carries
 * `data-status="closed"`, `data-messages`, `data-mine` and `data-thread-link` hooks that were
 * added to be asserted and were asserted nowhere, so inverting the page's open-ternary — a
 * closed thread rendering a live send box — reddened no test. The behaviour WAS verified on a
 * local Supabase stack this session (40/40 checks), but a live pass is not a regression guard:
 * it runs when someone runs it, and the next session changing this code gets nothing from it.
 *
 * WHAT THIS FILE CANNOT DO, stated rather than implied: the thread page is an async Server
 * Component that builds a cookie-bound Supabase client, so it cannot be rendered here — the
 * three tests that would matter most (404 for a third person, the message list, the open/closed
 * branch) are not reachable by this instrument. What IS covered is every decision the page's
 * render depends on, at the same boundary values, plus the form's own two states. The page's
 * wiring of those decisions stays covered by the live pass alone, and that gap is recorded in
 * the PR body rather than papered over.
 */

const match = { id: "m1", post_id: "p1", skipper_id: "sam", crew_id: "cy", accepted_at: "2026-08-22T12:00:00Z" };
const names = new Map([
  ["sam", "Sam"],
  ["cy", "Cy"],
]);
const CONTACT = { email: "cy@hsc-crew.org", phone: "614-555-0102" };
const RACE = "2027-06-13T17:00:00Z";
const DAY = 24 * 60 * 60 * 1000;

describe("the thread link on a match (AC 2's way in)", () => {
  it("is rendered to both parties, keyed by the post", () => {
    for (const viewer of ["sam", "cy"]) {
      const html = renderToStaticMarkup(
        <MatchPanel match={match} viewerId={viewer} names={names} contact={CONTACT} />,
      );
      expect(html).toContain('data-thread-link="p1"');
      expect(html).toContain("/post/p1/thread");
    }
  });

  it("is NOT rendered to a bystander, who has no thread to open", () => {
    // The panel is handed a contact row here too, on purpose — the absence is the component
    // withholding it rather than the test never passing one (MatchPanel.test.tsx's own rule).
    const html = renderToStaticMarkup(
      <MatchPanel match={match} viewerId="otto" names={names} contact={CONTACT} />,
    );
    expect(html).not.toContain("data-thread-link");
    expect(html).not.toContain("/thread");
  });
});

describe("what the page's open/closed branch is decided on (AC 5)", () => {
  // The page renders the send form when `threadIsOpen(starts_at, now)` and the closed note
  // otherwise. These are the same boundary values the page passes, so a change to the rule
  // reddens here even though the page itself cannot be rendered by this instrument.
  it("is open on the race day and through the following week", () => {
    expect(threadIsOpen(RACE, new Date(new Date(RACE).getTime() + 0))).toBe(true);
    expect(threadIsOpen(RACE, new Date(new Date(RACE).getTime() + 6 * DAY))).toBe(true);
  });

  it("is closed once seven days have passed, and the note says so in one sentence", () => {
    expect(threadIsOpen(RACE, new Date(new Date(RACE).getTime() + 8 * DAY))).toBe(false);
    // The page renders THREAD_CLOSED_NOTE verbatim, so the sentence is asserted once here and
    // the page cannot drift from it without changing this constant.
    expect(THREAD_CLOSED_NOTE).toContain("closed");
    expect(THREAD_CLOSED_NOTE).toContain("read");
    expect(explainMessageRefusal("closed")).toBe(THREAD_CLOSED_NOTE);
  });
});

describe("the body cap the form, the action and 0020 all read (AC 2)", () => {
  it("is one constant, and the refusal names it to the person", () => {
    expect(MESSAGE_BODY_MAX).toBe(2000);
    // The textarea's maxLength, the action's refusal and the migration's check all read this.
    // test/migrations-hygiene.test.ts holds it equal to the constraint actually in force.
    expect(explainMessageRefusal("too_long")).toContain("2,000");
  });

  it("explains every refusal the action can return, and never shows a raw code", () => {
    for (const reason of ["too_long", "empty", "closed", "refused"]) {
      const sentence = explainMessageRefusal(reason);
      expect(sentence.length).toBeGreaterThan(10);
      // No SNAKE_CASE code leaks into the sentence. Checked against the underscored spelling
      // rather than the whole reason, because an English word in the sentence is fine and
      // expected — "closed" appears in the closed-thread note on purpose, which a blanket
      // `not.toContain(reason)` flagged as a leak on the first run of this test.
      expect(sentence).not.toContain("_");
      expect(sentence).toMatch(/^[A-Z]/);
      expect(sentence).toMatch(/[.!]$/);
    }
    expect(explainMessageRefusal("a_new_code")).toBe("That could not be sent.");
  });
});
