import { describe, expect, it } from "vitest";
import { decideCallback, explainReason } from "./callback";

describe("decideCallback — what the callback does with its query (#70 AC 7)", () => {
  it("exchanges when a code is present, whatever else rides along", () => {
    expect(decideCallback({ code: "abc" })).toEqual({ kind: "exchange", code: "abc" });
    expect(decideCallback({ code: "abc", error: "ignored" })).toEqual({ kind: "exchange", code: "abc" });
  });

  it("reads a cancellation at Google as a cancellation, not a fault", () => {
    expect(decideCallback({ error: "access_denied" })).toEqual({ kind: "back", reason: "cancelled" });
    expect(decideCallback({ error: "server_error", error_code: "access_denied" })).toEqual({
      kind: "back",
      reason: "cancelled",
    });
    expect(
      decideCallback({ error: "server_error", error_description: "User cancelled the consent flow" }),
    ).toEqual({ kind: "back", reason: "cancelled" });
  });

  it("an expired or used magic link is link-invalid, not a Google fault (GoTrue's PKCE shape)", () => {
    expect(
      decideCallback({ error: "access_denied", error_code: "otp_expired", error_description: "Email link is invalid or has expired" }),
    ).toEqual({ kind: "back", reason: "link-invalid" });
    expect(decideCallback({ error: "server_error", error_description: "Token has expired" })).toEqual({
      kind: "back",
      reason: "link-invalid",
    });
  });

  it("a bare 'Access denied' description with a generic code is still a cancellation", () => {
    expect(decideCallback({ error: "server_error", error_description: "Access denied" })).toEqual({
      kind: "back",
      reason: "cancelled",
    });
  });

  // #74: the link leg's own refusal. GoTrue links the identity at ITS provider callback, so an
  // already-taken Google account never reaches linkIdentity's return — it arrives here as a
  // query parameter, and without this line it would read as a generic "try again", which cannot
  // work. Placed before otp_expired because it is the more specific code.
  it("names an already-taken Google account as already-linked, not as a provider error", () => {
    expect(
      decideCallback({
        error: "server_error",
        error_code: "identity_already_exists",
        error_description: "Identity is already linked to another user",
      }),
    ).toEqual({ kind: "back", reason: "already-linked" });
  });

  it("names any other provider failure as a provider error", () => {
    expect(decideCallback({ error: "server_error", error_description: "Unable to exchange external code" })).toEqual(
      { kind: "back", reason: "provider-error" },
    );
    expect(decideCallback({ error_code: "unexpected_failure" })).toEqual({ kind: "back", reason: "provider-error" });
  });

  it("still answers missing-code for an empty query — a truncated magic link", () => {
    expect(decideCallback({})).toEqual({ kind: "back", reason: "missing-code" });
    expect(decideCallback({ code: "", error: null })).toEqual({ kind: "back", reason: "missing-code" });
  });
});

describe("explainReason — plain words for every reason the callback can return", () => {
  it("has a distinct sentence for each known reason and a fallback for the rest", () => {
    const known = ["link-invalid", "not-invited", "missing-code", "cancelled", "provider-error", "already-linked"];
    const sentences = known.map(explainReason);
    expect(new Set(sentences).size).toBe(known.length);
    // Distinctness alone does not catch a reason falling through to the fallback — the fallback
    // is distinct too, so deleting a case leaves the set the same size. Predicted before running
    // the #74 mutation pass; without this line, removing `already-linked` reddened nothing.
    expect(sentences).not.toContain(explainReason("no-such-reason"));
    expect(explainReason("cancelled")).toMatch(/cancelled/i);
    expect(explainReason("cancelled")).not.toMatch(/error|fault|wrong/i);
    expect(explainReason("not-invited")).toMatch(/invite code/i);
    expect(explainReason("whatever")).toMatch(/did not complete/);
  });

  /**
   * #74 AC 3. This is the sentence a returning member sees when their Google address differs
   * from the one they joined with — the commonest way to reach `not-invited`, because Supabase
   * links a Google identity only on a matching verified email. It used to say ONLY "sign up with
   * this season's invite code", and following that advice gave the same human a second person
   * row. The advice must now lead them to sign in and then link.
   */
  it("tells an existing member to sign in and link, not to sign up again (AC 3)", () => {
    const s = explainReason("not-invited");
    expect(s).toMatch(/already a member/i);
    expect(s).toMatch(/sign in with the email you joined with/i);
    expect(s).toMatch(/link Google from your profile/i);
    // the sign-up route is still offered — but second, and only to someone who is new
    expect(s).toMatch(/invite code/i);
    expect(s.search(/already a member/i)).toBeLessThan(s.search(/invite code/i));
  });

  /**
   * #82. "Sign in with the email you joined with" now means email + PASSWORD, and the population
   * that reaches these two sentences is the one least likely to have one: a Google-created
   * account has none, and neither does any account made before #82. Without the Forgot pointer
   * the advice sends them to a screen they cannot get through. Both sentences give this advice,
   * so both are asserted — the sibling was the one missed when #74 wrote it.
   */
  it("points a password-less member at Forgot my password, in both sentences that say to sign in", () => {
    for (const reason of ["not-invited", "already-linked"]) {
      const s = explainReason(reason);
      expect(s, reason).toMatch(/sign in with the email you joined with/i);
      expect(s, reason).toMatch(/forgot my password/i);
      // the pointer sits with the advice it qualifies, not tacked on after the alternative
      expect(s.search(/forgot my password/i), reason).toBeLessThan(
        s.search(/invite code|different Google account/i),
      );
    }
  });
});
