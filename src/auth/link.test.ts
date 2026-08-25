import { describe, expect, it } from "vitest";
import { explainProfileRefusal } from "@/profile/profile";
import {
  LINK_DONE,
  LINK_PATH,
  backPathFor,
  decideLinkStart,
  explainLinkReason,
  hasGoogleIdentity,
  isLinkFlow,
  linkReason,
  restoreVerifiers,
  verifierCookies,
} from "./link";

/**
 * #74 — linking a Google account at a different address to an existing member.
 *
 * Every branch here is reached in production only by a GoTrue refusal that this session could
 * not provoke (the live project has manual linking OFF and Docker was down, so the local stack
 * was unavailable). The codes are therefore the contract: two were MEASURED against the live
 * project (401 no_authorization, 403 bad_jwt) and two read off supabase/auth's own source
 * (404 manual_linking_disabled from `requireManualLinkingEnabled`, 422 identity_already_exists).
 * If GoTrue ever renames one, these tests keep passing and the member gets the generic sentence
 * — which is the honest failure and is written down rather than papered over.
 */

describe("linkReason — which refusal, from GoTrue's error_code alone", () => {
  it("names the project setting when manual linking is off", () => {
    expect(linkReason({ code: "manual_linking_disabled", message: "Manual linking is disabled" })).toBe(
      "linking-disabled",
    );
  });

  it("reads every way GoTrue rejects the token as not-signed-in", () => {
    expect(linkReason({ code: "no_authorization", message: "requires a valid Bearer token" })).toBe(
      "not-signed-in",
    );
    expect(linkReason({ code: "bad_jwt", message: "invalid JWT" })).toBe("not-signed-in");
    expect(linkReason({ code: "session_not_found", message: "Session not found" })).toBe("not-signed-in");
  });

  it("names an already-taken Google account as such, not as a fault", () => {
    expect(
      linkReason({ code: "identity_already_exists", message: "Identity is already linked to another user" }),
    ).toBe("already-linked");
  });

  it("falls back to a provider error for anything it does not know, including no code at all", () => {
    expect(linkReason({ code: "unexpected_failure", message: "boom" })).toBe("provider-error");
    expect(linkReason({ message: "no code on this one" })).toBe("provider-error");
    expect(linkReason(null)).toBe("provider-error");
    expect(linkReason(undefined)).toBe("provider-error");
  });

  it("matches the code and NOT the message — one mechanism, so a test can tell which one works", () => {
    // The message says exactly what the code would have said; only the code decides.
    expect(linkReason({ message: "Manual linking is disabled" })).toBe("provider-error");
    expect(linkReason({ message: "Identity is already linked to another user" })).toBe("provider-error");
  });
});

describe("decideLinkStart — send the browser on, or explain", () => {
  it("redirects to the URL linkIdentity returned", () => {
    expect(decideLinkStart({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })).toEqual({
      kind: "redirect",
      url: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    });
  });

  it("carries the refusal back rather than the raw error", () => {
    expect(decideLinkStart({ error: { code: "manual_linking_disabled", message: "off" } })).toEqual({
      kind: "back",
      reason: "linking-disabled",
    });
    expect(decideLinkStart({ error: { code: "no_authorization", message: "no token" } })).toEqual({
      kind: "back",
      reason: "not-signed-in",
    });
  });

  it("treats a success carrying no URL as a provider error rather than redirecting nowhere", () => {
    expect(decideLinkStart({ url: null })).toEqual({ kind: "back", reason: "provider-error" });
    expect(decideLinkStart({})).toEqual({ kind: "back", reason: "provider-error" });
    expect(decideLinkStart({ url: "" })).toEqual({ kind: "back", reason: "provider-error" });
  });

  /**
   * The README tells the owner that pressing the control IS the check for *Allow manual linking*,
   * because `GET /auth/v1/settings` cannot report it — so this one sentence is a documented
   * instrument, and nothing tied GoTrue's code to it end to end. Found by a mutation predicting
   * 3 red and getting 2: each hop was covered, the chain was not.
   */
  it("a project with manual linking off produces the sentence the README promises (AC 4)", () => {
    const d = decideLinkStart({ error: { code: "manual_linking_disabled", message: "Manual linking is disabled" } });
    expect(d).toEqual({ kind: "back", reason: "linking-disabled" });
    const sentence = explainLinkReason(d.kind === "back" ? d.reason : "unreachable");
    expect(sentence).toMatch(/not switched on for this club/i);
    // and it must not read like the generic failure, or the readout tells you nothing
    expect(sentence).not.toBe(explainLinkReason("provider-error"));
  });

  it("prefers the error even when a URL came back with it", () => {
    expect(decideLinkStart({ url: "https://example.invalid", error: { code: "bad_jwt", message: "x" } })).toEqual(
      { kind: "back", reason: "not-signed-in" },
    );
  });
});

describe("backPathFor — a signed-in member is never dropped on the sign-in page", () => {
  it("returns the profile for the link leg", () => {
    expect(backPathFor("link")).toBe(LINK_PATH);
    expect(backPathFor("link")).toBe("/profile");
  });

  it("returns /join for every other value, including near misses and casing", () => {
    for (const v of [null, undefined, "", "signin", "links", "LINK", "Link", " link", "link "]) {
      expect(backPathFor(v), `flow=${JSON.stringify(v)}`).toBe("/join");
    }
  });

  it("isLinkFlow agrees with it exactly — one predicate, so the two cannot drift", () => {
    for (const v of [null, undefined, "", "link", "LINK", "links", "signin"]) {
      expect(isLinkFlow(v)).toBe(backPathFor(v) === LINK_PATH);
    }
  });

  it("the success landing is on the profile and carries the marker the page confirms on", () => {
    expect(LINK_DONE.startsWith(`${LINK_PATH}?`)).toBe(true);
    expect(new URLSearchParams(LINK_DONE.split("?")[1]).get("linked")).toBe("google");
  });
});

describe("explainLinkReason — plain words, and silence on reasons it does not own", () => {
  const MINE = ["linking-disabled", "not-signed-in", "already-linked", "provider-error", "cancelled", "link-invalid"];

  it("has a distinct sentence for each of its own reasons", () => {
    const sentences = MINE.map(explainLinkReason);
    expect(sentences.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(MINE.length);
  });

  it("says nothing was linked wherever that is the member's real question", () => {
    for (const r of ["not-signed-in", "provider-error", "cancelled"]) {
      expect(explainLinkReason(r), r).toMatch(/nothing (was linked|has changed)/i);
    }
    // and the one that is off at the project level names the club, not the member
    expect(explainLinkReason("linking-disabled")).toMatch(/not switched on|club/i);
    expect(explainLinkReason("linking-disabled")).not.toMatch(/try again/i);
  });

  it("returns null for an unknown reason so /profile can fall through to its own", () => {
    expect(explainLinkReason("whatever")).toBeNull();
    expect(explainLinkReason("")).toBeNull();
  });

  /**
   * /profile renders `explainLinkReason(error) ?? explainProfileRefusal(error)`, so the two
   * vocabularies share one `?error=` namespace. If they ever overlap, the link sentence silently
   * shadows the profile one and a save refusal reads as a Google problem. This is the assertion
   * that stops it, and it is here rather than in profile.test.ts because link.ts is the shadower.
   */
  it("shares no key with the profile-save refusals it would otherwise shadow", () => {
    for (const r of ["blank-rating", "no-hull-chosen", "unknown-class", "phone-invalid", "refused"]) {
      expect(explainLinkReason(r), `link.ts must not own ${r}`).toBeNull();
      // positive control: the profile module really does answer for these, so a null above is
      // link.ts staying out of the way rather than the key being meaningless.
      expect(explainProfileRefusal(r)).not.toBe(explainProfileRefusal("some-unknown-key"));
    }
  });
});

/**
 * The PKCE-verifier repair. `linkIdentity` writes a verifier before it asks whether the link may
 * proceed and cleans nothing up on refusal, so a refused start overwrites the fixed key
 * /auth/callback reads and kills a magic link already in the member's inbox. With *Allow manual
 * linking* off — the Supabase default, and the live project's state on 2026-08-24 — refusal is
 * the ordinary path, so this runs on every press until the owner flips it.
 */
describe("verifierCookies / restoreVerifiers — a refused link must not eat a pending magic link", () => {
  const K = "sb-proj-auth-token-code-verifier";
  const SLOT = "sb-proj-auth-token-flow-abcdef0123456789-code-verifier";
  const INDEX = "sb-proj-auth-token-flows-code-verifier";

  it("picks out all three shapes @supabase/ssr writes, and nothing else", () => {
    const all = [
      { name: K, value: "1" },
      { name: SLOT, value: "2" },
      { name: INDEX, value: "3" },
      { name: "sb-proj-auth-token", value: "session" },
      { name: "tender_gate", value: "pass" },
      { name: "code-verifier-decoy", value: "x" },
    ];
    expect(verifierCookies(all).map((c) => c.name)).toEqual([K, SLOT, INDEX]);
  });

  it("puts a clobbered verifier back to the value the magic link needs", () => {
    const plan = restoreVerifiers([{ name: K, value: "MAGIC" }], [{ name: K, value: "FROM-THE-LINK" }]);
    expect(plan).toEqual([{ name: K, value: "MAGIC" }]);
  });

  it("deletes the keys the failed start added, so nothing is left behind either", () => {
    const plan = restoreVerifiers(
      [{ name: K, value: "MAGIC" }],
      [{ name: K, value: "NEW" }, { name: SLOT, value: "NEW" }, { name: INDEX, value: "[]" }],
    );
    expect(plan).toEqual([
      { name: K, value: "MAGIC" },
      { name: SLOT, value: null },
      { name: INDEX, value: null },
    ]);
  });

  it("leaves a jar that had no pending flow empty rather than writing a blank cookie", () => {
    expect(restoreVerifiers([], [{ name: K, value: "NEW" }])).toEqual([{ name: K, value: null }]);
    expect(restoreVerifiers([], [])).toEqual([]);
  });

  it("plans nothing when the start wrote nothing — no cookie is touched for no reason", () => {
    const same = [{ name: K, value: "MAGIC" }];
    expect(restoreVerifiers(same, [...same])).toEqual([]);
  });
});

describe("hasGoogleIdentity — which control /profile shows", () => {
  it("is true when a google identity is among them, alongside others", () => {
    expect(hasGoogleIdentity([{ provider: "email" }, { provider: "google" }])).toBe(true);
    expect(hasGoogleIdentity([{ provider: "google" }])).toBe(true);
  });

  it("is false for email alone, an empty list, and a client that sent no list at all", () => {
    expect(hasGoogleIdentity([{ provider: "email" }])).toBe(false);
    expect(hasGoogleIdentity([])).toBe(false);
    expect(hasGoogleIdentity(null)).toBe(false);
    expect(hasGoogleIdentity(undefined)).toBe(false);
  });

  it("does not match a provider that merely contains the word", () => {
    expect(hasGoogleIdentity([{ provider: "google_oidc" }, { provider: "notgoogle" }])).toBe(false);
  });
});
