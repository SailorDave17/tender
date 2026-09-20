import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EmailUsage as Usage } from "@/admin/email-usage";
import { EMAIL_DAY_CAP, EMAIL_MONTH_CAP } from "@/notify/rung";
import { EmailUsage } from "./EmailUsage";

/**
 * Story #39 AC 1 and AC 3. /admin prints the day's email count against 100 and the month's
 * against 3,000, amber at 70 and red at 90, with one line saying what the figures include and
 * exclude. The page is an async Server Component that reads the session and the database, so the
 * readings are rendered here from the component the page hands its figures to.
 *
 * Stated blind spot, the same one `SeasonSummary.test.tsx` carries: this never runs the page's own
 * RPC. That `email_usage()` counts the right rows is `test/email-usage.test.ts`'s job (real SQL);
 * that `loadEmailUsage` sends the arguments PostgREST resolves on is held by
 * `test/migrations-hygiene.test.ts`, which compares every `.rpc("…", {…})` in `src/` against the
 * harness's own argument names. The spelling of the call itself is exercised by none of the three,
 * and the first render of /admin after promotion is its first test.
 *
 * Assertions read attribute values rather than prose wherever a number or a level is the claim —
 * React renders a bare boolean data attribute as `data-x="true"` (#145), so the bare ones are
 * matched loosely and never assumed empty.
 */

const WINDOWS = {
  dayStart: new Date("2026-09-20T00:00:00Z"),
  monthStart: new Date("2026-09-01T00:00:00Z"),
};

function usage(day: number, month: number, error: string | null = null): Usage {
  return { day, month, dayCap: EMAIL_DAY_CAP, monthCap: EMAIL_MONTH_CAP, ...WINDOWS, error };
}

const render = (u: Usage) => renderToStaticMarkup(<EmailUsage usage={u} />);

/** The value of a `data-` attribute on any element, or undefined. */
function attr(html: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
}

describe("EmailUsage — AC 1, the figures and their colour", () => {
  it("prints 'N of 100' for the day and 'M of 3,000' for the month", () => {
    const html = render(usage(12, 480));
    expect(attr(html, "data-day-count")).toBe("12");
    expect(attr(html, "data-month-count")).toBe("480");
    // Plain substrings, no `<!-- -->` markers: `renderToStaticMarkup` emits none, and only the
    // `next dev` SSR output does (#19's finding is about the browser probe, and the two
    // instruments disagree on exactly this). A probe asserting these strings against a live page
    // would need the marker-tolerant form — or `innerText`, which is the #31 repair.
    expect(html).toContain("12 of 100");
    expect(html).toContain("480 of 3,000"); // the month is thousands-separated, the day is not
    expect(html).toContain("emails sent today");
    expect(html).toContain("this month");
  });

  it("green below 70, amber from 70, red from 90 — on the day", () => {
    expect(attr(render(usage(69, 0)), "data-day-level")).toBe("ok");
    expect(attr(render(usage(70, 0)), "data-day-level")).toBe("amber");
    expect(attr(render(usage(89, 0)), "data-day-level")).toBe("amber");
    expect(attr(render(usage(90, 0)), "data-day-level")).toBe("red");
  });

  it("the same rule on the month, at 2,100 and 2,700", () => {
    expect(attr(render(usage(0, 2_099)), "data-month-level")).toBe("ok");
    expect(attr(render(usage(0, 2_100)), "data-month-level")).toBe("amber");
    expect(attr(render(usage(0, 2_699)), "data-month-level")).toBe("amber");
    expect(attr(render(usage(0, 2_700)), "data-month-level")).toBe("red");
  });

  it("the two figures are coloured independently", () => {
    // A quiet day inside a heavy month, which is what the monthly cap is for: the day reads green
    // and the month red in one render. A single shared level would collapse them.
    const html = render(usage(3, 2_800));
    expect(attr(html, "data-day-level")).toBe("ok");
    expect(attr(html, "data-month-level")).toBe("red");
  });

  it("the warning is in the words too, not only in the colour", () => {
    // The assertion that matters for an admin who cannot see the colour, or who is reading this
    // anywhere the inline style does not survive.
    expect(render(usage(12, 0))).not.toContain("approaching the cap");
    expect(render(usage(70, 0))).toContain("approaching the cap");
    expect(render(usage(90, 0))).toContain("at the cap");
    expect(render(usage(90, 0))).toContain("will be skipped, not queued");
  });

  it("colour is present on a warning and absent on a quiet day", () => {
    expect(render(usage(90, 0))).toContain("#b00020");
    expect(render(usage(70, 0))).toContain("#b26a00");
    const quiet = render(usage(12, 40));
    expect(quiet).not.toContain("#b00020");
    expect(quiet).not.toContain("#b26a00");
  });
});

describe("EmailUsage — AC 3, the note", () => {
  const note = render(usage(12, 480));

  it("names what the count includes", () => {
    expect(attr(note, "data-usage-note")).toBe("true"); // bare attribute, matched loosely (#145)
    expect(note).toContain("notification emails Tender attempted");
    expect(note).toContain("accepted or refused");
  });

  it("names each of the three exclusions a reader would otherwise blame the number on", () => {
    expect(note).toContain("password-reset mail"); // the identity mail, invisible here since #99
    expect(note).toContain("skipped"); // cap and repeat-window rows are logged but never sent
    expect(note).toContain("no address on file");
  });

  it("says which day it means", () => {
    // UTC, not the club's evening — the count rolls over mid-morning in Ohio, and an admin
    // watching it climb on a Saturday night needs to know that before they read a reset as a bug.
    expect(note).toContain("UTC");
  });
});

describe("EmailUsage — a read that failed is never printed as zero", () => {
  const failed = render(usage(0, 0, "permission denied for function email_usage"));

  it("prints the failure and neither figure", () => {
    expect(attr(failed, "data-usage-error")).toBe("true");
    expect(failed).toContain("Could not read the email count");
    expect(failed).toContain("permission denied for function email_usage");
    // "0 of 100" is the most reassuring thing this screen can say and would be a lie here.
    expect(failed).not.toContain("emails sent today");
    expect(attr(failed, "data-day-count")).toBeUndefined();
  });

  it("says the cap itself is unaffected, so the admin does not read it as sending having stopped", () => {
    expect(failed).toContain("The sending cap is unaffected");
  });

  it("is an alert, so it is announced rather than only shown", () => {
    expect(failed).toContain('role="alert"');
  });
});
