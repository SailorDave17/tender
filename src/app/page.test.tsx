import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { explainReason } from "@/auth/callback";
import Home from "./page";

/**
 * #83 AC 1 and AC 2. The landing page is a Server Component doing no I/O, so it can be awaited and
 * rendered here — which is the only instrument that can answer this story's question, because the
 * defect was never in a function's return value. It was that `/` read no `searchParams` at all, and
 * *measured 2026-08-25* against the live project the page came back **byte-identical (6440 bytes)
 * with and without GoTrue's error parameters**. A test on the decision alone would have stayed green
 * through that.
 */
async function render(searchParams: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(await Home({ searchParams: Promise.resolve(searchParams) }));
}

describe("the landing page says what happened, and only when something did (#83)", () => {
  /**
   * AC 2 requires the negative control in the SAME test, so an always-on banner cannot pass. Both
   * arms are rendered here and compared against each other rather than against a fixed string.
   */
  it("shows the expiry message on GoTrue's parameters and nothing on an ordinary visit", async () => {
    const clean = await render({});
    const expired = await render({
      error: "invalid_request",
      error_code: "bad_oauth_state",
      error_description: "OAuth state not found or expired",
    });

    // the message arrives, in plain words, and offers the way back (AC 1)
    expect(expired).toContain(explainReason("state-expired"));
    expect(expired).toContain('role="alert"');
    const alert = expired.slice(expired.indexOf('role="alert"'), expired.indexOf("</p>", expired.indexOf('role="alert"')));
    expect(alert, "the way back sits with the message, not elsewhere on the page").toContain('href="/join"');

    // ...and the ordinary visit is untouched: no alert, no sentence, nothing added (AC 2)
    expect(clean).not.toContain('role="alert"');
    expect(clean).not.toContain("data-landing-error");
    expect(clean).not.toContain(explainReason("state-expired"));
    expect(clean).not.toContain(explainReason("state-used"));
    expect(clean).not.toMatch(/expired|already been used|took too long/i);

    // the page itself is otherwise the same page — everything the clean render carries survives
    expect(expired).toContain("The board that says who still needs a crew for Sunday.");
    expect(expired.length).toBeGreaterThan(clean.length);
    // and the two arms really did differ because of the parameters, not because rendering is
    // unstable: a second clean render must match the first exactly.
    expect(await render({})).toBe(clean);
  });

  it("distinguishes the two failures on the rendered page, not merely in the decision (AC 3)", async () => {
    const expired = await render({ error_code: "bad_oauth_state" });
    const used = await render({ error_code: "flow_state_already_used" });
    expect(expired).toContain(explainReason("state-expired"));
    expect(used).toContain(explainReason("state-used"));
    expect(expired).not.toContain(explainReason("state-used"));
    expect(used).not.toContain(explainReason("state-expired"));
  });

  it("still says something for a code it does not know, rather than rendering as though nothing happened", async () => {
    // The generic arm matters more here than on /join: whatever GoTrue sends to Site URL lands on a
    // page that, before this story, could not acknowledge any of it.
    const other = await render({ error: "server_error", error_description: "Unable to exchange external code" });
    expect(other).toContain(explainReason("provider-error"));
    expect(other).toContain('role="alert"');
  });
});
