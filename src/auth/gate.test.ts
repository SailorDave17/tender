import { describe, expect, it } from "vitest";
import { SIGN_IN_PATH, isProtected, redirectFor } from "./gate";

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

  it("lets a signed-in request through everywhere", () => {
    expect(redirectFor("/board", true)).toBeNull();
    expect(redirectFor("/join", true)).toBeNull();
  });

  it("leaves the open paths open — a person with no session must reach the page that gives one", () => {
    expect(redirectFor("/join", false)).toBeNull();
    expect(redirectFor("/auth/callback", false)).toBeNull();
    expect(redirectFor("/", false)).toBeNull();
    expect(redirectFor("/boardroom", false)).toBeNull(); // a prefix is not a path segment
  });

  it("isProtected matches segments, not prefixes", () => {
    expect(isProtected("/board")).toBe(true);
    expect(isProtected("/board/")).toBe(true);
    expect(isProtected("/boards")).toBe(false);
  });
});
