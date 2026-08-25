import { describe, expect, it } from "vitest";
import { explainReason } from "./callback";
import { decideLanding, explainLanding } from "./landing";

/**
 * #83. The decision is pure by construction — a query object in, a reason key out — so every one
 * of GoTrue's shapes is a unit test with no request, no cookies and no Supabase (AC 4).
 *
 * The three codes below were taken from `supabase/auth` `internal/api/external.go` and, where a
 * probe could produce them, verified against the live project on 2026-08-24.
 */
describe("decideLanding — the reason GoTrue left on the landing page (AC 4)", () => {
  it("says nothing at all for an ordinary visit — the negative control", () => {
    expect(decideLanding({})).toBeNull();
    expect(decideLanding({ error: null, error_code: null, error_description: null })).toBeNull();
    expect(decideLanding({ error: "", error_code: "", error_description: "" })).toBeNull();
  });

  it("reads an expired or unusable OAuth state as an expiry, whatever the description says", () => {
    // All three `bad_oauth_state` descriptions GoTrue can produce. `error_code` is the contract and
    // the description is prose the project does not control, so one branch covers the family.
    for (const error_description of [
      "OAuth state not found or expired",
      "OAuth state has expired",
      "OAuth state parameter is invalid",
    ]) {
      expect(decideLanding({ error: "invalid_request", error_code: "bad_oauth_state", error_description })).toBe(
        "state-expired",
      );
    }
  });

  it("reads an already-used callback as already-used, not as an expiry", () => {
    expect(
      decideLanding({
        error: "invalid_request",
        error_code: "flow_state_already_used",
        error_description: "State has already been used",
      }),
    ).toBe("state-used");
  });

  it("reads a callback whose state parameter is missing as an incomplete link", () => {
    // Not one of the three the issue named — found by probing the same endpoint with no `state` at
    // all (measured 2026-08-24). It needs no new sentence: `missing-code` already says it.
    expect(
      decideLanding({
        error: "invalid_request",
        error_code: "bad_oauth_callback",
        error_description: "OAuth state parameter missing",
      }),
    ).toBe("missing-code");
  });

  it("names anything else a provider error rather than guessing", () => {
    expect(decideLanding({ error_code: "user_not_found" })).toBe("provider-error");
    expect(decideLanding({ error: "server_error" })).toBe("provider-error");
    // A description on its own is still an error the member should hear about.
    expect(decideLanding({ error_description: "Something went wrong upstream" })).toBe("provider-error");
  });

  it("falls back to `error` when GoTrue sends no `error_code`", () => {
    // The live redirects all carry both, but the fallback is what makes the branch above reachable
    // for a caller that only has one; without it a bare `error` would answer provider-error.
    expect(decideLanding({ error: "bad_oauth_state" })).toBe("state-expired");
    expect(decideLanding({ error: "BAD_OAUTH_STATE" })).toBe("state-expired");
    // and `error_code` wins when both are present
    expect(decideLanding({ error: "invalid_request", error_code: "flow_state_already_used" })).toBe("state-used");
  });
});

/**
 * AC 3. Two failures, two sentences, and the difference has to survive being read by a person who
 * has just been bounced back to the home page for no visible reason.
 */
describe("the sentences the landing page shows (AC 3)", () => {
  const expired = explainReason("state-expired");
  const used = explainReason("state-used");

  it("distinguishes 'that took too long' from 'that link was already used'", () => {
    expect(expired).toMatch(/took too long/i);
    expect(expired).not.toMatch(/already been used|already used/i);
    expect(used).toMatch(/already been used/i);
    expect(used).not.toMatch(/took too long/i);
    expect(expired).not.toBe(used);
  });

  it("neither reads as a fault the member caused", () => {
    for (const s of [expired, used]) {
      expect(s).not.toMatch(/you (?:failed|forgot|should have)|your (?:fault|mistake)|invalid|denied|not allowed/i);
      // and both say what to do next, because being told what happened and not what to do is the
      // state this story exists to leave behind
      expect(s).toMatch(/start again/i);
    }
  });

  it("reuses explainReason rather than growing a second vocabulary (AC 4)", () => {
    // explainLanding is the one call the page makes; it must be the SAME sentence explainReason
    // gives, so a wording change has one home. A private copy here would pass a substring check.
    expect(explainLanding({ error_code: "bad_oauth_state" })).toBe(expired);
    expect(explainLanding({ error_code: "flow_state_already_used" })).toBe(used);
    expect(explainLanding({ error_code: "bad_oauth_callback" })).toBe(explainReason("missing-code"));
    expect(explainLanding({})).toBeNull();
  });

  it("keeps every reason key distinct — a new case must not fall through to the fallback", () => {
    // The #74 pass found that distinctness alone cannot catch a deleted case, because the fallback
    // is distinct too. These two are checked against the fallback by name for the same reason.
    const known = [
      "link-invalid",
      "state-expired",
      "state-used",
      "not-invited",
      "missing-code",
      "cancelled",
      "provider-error",
      "already-linked",
    ];
    const sentences = known.map(explainReason);
    expect(new Set(sentences).size).toBe(known.length);
    expect(sentences).not.toContain(explainReason("no-such-reason"));
  });
});
