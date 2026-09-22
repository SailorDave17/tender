import { describe, expect, it } from "vitest";
import { PROTECTED_PREFIXES, SIGN_IN_PATH, SIGNED_IN_HOME, isProtected, redirectFor } from "./gate";

describe("the proxy's decision (AC 1 / AC 5)", () => {
  it("sends an unauthenticated request for /board, and anything under it, to /join", () => {
    expect(redirectFor("/board", false)).toBe(SIGN_IN_PATH);
    expect(redirectFor("/board/2027-05-02", false)).toBe(SIGN_IN_PATH);
    expect(redirectFor("/admin", false)).toBe(SIGN_IN_PATH);
    expect(redirectFor("/profile", false)).toBe(SIGN_IN_PATH); // #18: the profile is behind sign-in
    expect(redirectFor("/profile/ann", false)).toBe(SIGN_IN_PATH);
    expect(redirectFor("/boats", false)).toBe(SIGN_IN_PATH); // #19
    expect(redirectFor("/post/new", false)).toBe(SIGN_IN_PATH);
    expect(redirectFor("/post/abc", false)).toBe(SIGN_IN_PATH);
  });

  it("lets a signed-in request through everywhere except the sign-in screen (#123 AC 7)", () => {
    expect(redirectFor("/board", true)).toBeNull();
    // ...and /join is the exception this story adds: a member with a live session was being shown
    // a sign-in form and asked to sign in again. (This case asserted `null` until #123.)
    expect(redirectFor("/join", true)).toBe(SIGNED_IN_HOME);
    expect(SIGNED_IN_HOME).toBe("/board");
  });

  it("leaves the open paths open — a person with no session must reach the page that gives one", () => {
    expect(redirectFor("/join", false)).toBeNull();
    expect(redirectFor("/auth/callback", false)).toBeNull();
    expect(redirectFor("/", false)).toBeNull();
    expect(redirectFor("/boardroom", false)).toBeNull(); // a prefix is not a path segment
  });

  it("leaves /support and /privacy open to a stranger — madcowsailing.com links there (#147)", () => {
    // Signed out is the case that matters: the product page's readers have never had an account,
    // and the person who needs /support most is the one who cannot sign in.
    for (const path of ["/support", "/privacy"]) {
      expect(redirectFor(path, false), `${path} signed out`).toBeNull();
      expect(isProtected(path), `${path} is not gated`).toBe(false);
    }
  });

  it("isProtected matches segments, not prefixes", () => {
    expect(isProtected("/board")).toBe(true);
    expect(isProtected("/board/")).toBe(true);
    expect(isProtected("/boards")).toBe(false);
  });
});

describe("the signed-in arm sends them off /join and nowhere else (#123 AC 7)", () => {
  /**
   * The second half of the criterion, and the one worth a test of its own: the change adds a
   * redirect on the arm that until now always answered `null`, so the risk it carries is not
   * "does /join work" but "what else did this just start redirecting". A single `expect` on
   * `/join` cannot see that; a sweep can.
   */
  const EVERY_OTHER_PATH = [
    "/",
    "/forgot",
    "/auth/callback",
    "/api/signin/google",
    "/api/signup/google",
    "/auth/link/google",
    "/auth/signout",
    "/api/signin",
    "/api/join",
    "/manifest.webmanifest",
    "/support", // #147
    "/privacy",
    "/joining", // /join is a path, not a prefix — this one must be left alone
    "/join/extra",
    ...PROTECTED_PREFIXES,
  ];

  it("returns null for a signed-in member on every ungated path that is not /join", () => {
    for (const path of EVERY_OTHER_PATH) {
      expect(redirectFor(path, true), `${path} must not redirect a signed-in member`).toBeNull();
    }
    // The positive control: a sweep over a list that missed the one path under test would pass
    // this silently (cairn: an-absent-result-reads-as-a-clean-one).
    expect(EVERY_OTHER_PATH).not.toContain(SIGN_IN_PATH);
    expect(redirectFor(SIGN_IN_PATH, true)).toBe(SIGNED_IN_HOME);
  });

  it("leaves the signed-OUT arm exactly as it was — /join still opens for a stranger", () => {
    // The whole point: a person with no session must still reach the page that gives them one.
    expect(redirectFor("/join", false)).toBeNull();
    expect(redirectFor("/board", false)).toBe(SIGN_IN_PATH);
  });

  it("does not send a signed-in member somewhere that would bounce them back", () => {
    // /board is protected, so the redirect target has to be a path a signed-in member may have —
    // otherwise this is a loop rather than a redirect.
    expect(isProtected(SIGNED_IN_HOME)).toBe(true);
    expect(redirectFor(SIGNED_IN_HOME, true)).toBeNull();
  });
});
