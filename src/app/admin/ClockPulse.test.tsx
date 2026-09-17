import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClockPulse } from "./ClockPulse";

/**
 * #145 AC 4. /admin prints the daily sweep beside the quarter-hour tick, and "never" when the
 * sweep's stamp is empty. The page is an async Server Component that reads the session and the
 * database, so the two readings are rendered here from the component the page hands its row to.
 *
 * Stated blind spot: this never runs the page's own `select("last_at, sweep_at")`. The column's
 * readability by an admin is test/tick.test.ts's (real SQL); the spelling of the select is not
 * exercised by any test, and the post-promotion read of /admin that #145's last criterion needs
 * is the first run of it.
 */

const NOW = new Date("2026-09-14T14:00:00Z");

/**
 * The text of `<strong {attr}>`, or undefined when there is none. React renders a bare boolean
 * data attribute as `data-x="true"`, so the value is matched loosely rather than assumed empty.
 */
function reading(html: string, attr: string): string | undefined {
  return new RegExp(`<strong ${attr}(?:="[^"]*")?>([^<]*)</strong>`).exec(html)?.[1];
}

function render(lastAt: Date | null, sweepAt: Date | null): string {
  return renderToStaticMarkup(<ClockPulse lastAt={lastAt} sweepAt={sweepAt} now={NOW} />);
}

describe("/admin's ladder clock: the daily sweep beside the quarter-hour tick (#145 AC 4)", () => {
  it("prints each clock from its own stamp, and the sweep's time in UTC", () => {
    const html = render(new Date("2026-09-14T13:57:00Z"), new Date("2026-09-14T12:37:00Z"));
    expect(reading(html, "data-last-tick")).toBe("3 min ago");
    expect(reading(html, "data-last-sweep")).toBe("83 min ago");
    expect(html).toMatch(/<time [^>]*2026-09-14T12:37:00\.000Z[^>]*>2026-09-14 12:37 UTC<\/time>/);
    expect(html.indexOf("data-last-tick")).toBeLessThan(html.indexOf("data-last-sweep")); // beside it, after it
  });

  it("says never for an empty sweep stamp while the tick has one — the state right after 0019 is pasted", () => {
    const html = render(new Date("2026-09-14T13:57:00Z"), null);
    expect(reading(html, "data-last-tick")).toBe("3 min ago"); // the control: the other clock still reads
    expect(reading(html, "data-last-sweep")).toBe("never");
    expect(html).not.toContain("<time");
  });

  it("says never for both before the first tick", () => {
    const html = render(null, null);
    expect(reading(html, "data-last-tick")).toBe("never");
    expect(reading(html, "data-last-sweep")).toBe("never");
  });
});
