import { describe, expect, it } from "vitest";
import {
  RECOGNITION_COOKIE,
  RECOGNITION_MAX_AGE_S,
  RECOGNITION_VALUE,
  type RecognitionOptions,
  initialMode,
  isRecognized,
  recognitionOptions,
  rememberDevice,
} from "./recognition";

/**
 * #123 AC 3 and AC 6. The decision and the cookie's shape, with no request and no browser —
 * `initialMode` is pure and `rememberDevice` takes the store as an argument, so both are
 * answerable here. What the three ROUTES do with them is a different claim and is measured by
 * driving the real handlers in `test/device-recognition.test.ts`; asserting the shape here and
 * the wiring there is the split, not a substitute for it.
 */

describe("which tab /join opens on (#123 AC 3)", () => {
  it("opens on Sign up for a browser that has never signed in here", () => {
    expect(initialMode(undefined, false)).toBe("signup");
  });

  it("opens on Sign in for a browser that has, which is what it did for everybody before", () => {
    expect(initialMode(undefined, true)).toBe("signin");
  });

  it("lets ?mode= beat the cookie IN BOTH DIRECTIONS — it is a link somebody was sent", () => {
    // The direction that already worked...
    expect(initialMode("signup", false)).toBe("signup");
    // ...and the two that are the point of "in both directions": the parameter has to win when it
    // disagrees with the device, or the deep link JoinForm's docblock describes stops working for
    // the recognised member and the new default stops being overridable at all.
    expect(initialMode("signup", true)).toBe("signup");
    expect(initialMode("signin", false)).toBe("signin");
    expect(initialMode("signin", true)).toBe("signin");
  });

  it("ignores a parameter that is neither, and falls back to the device", () => {
    // `?mode=banana` is not a third tab; it is a URL nobody meant, and the device still knows.
    expect(initialMode("banana", false)).toBe("signup");
    expect(initialMode("banana", true)).toBe("signin");
    expect(initialMode("", false)).toBe("signup");
    expect(initialMode(null, true)).toBe("signin");
  });
});

describe("reading the cookie (#123 AC 1 / AC 2)", () => {
  it("recognises the marker and nothing else", () => {
    expect(isRecognized(RECOGNITION_VALUE)).toBe(true);
    expect(isRecognized(undefined)).toBe(false);
    expect(isRecognized(null)).toBe(false);
    expect(isRecognized("")).toBe(false);
    // A cookie of that name holding something else is not this cookie. Nothing writes one today,
    // and reading any value as recognition would make an emptied cookie mean "signed in here".
    expect(isRecognized("0")).toBe(false);
    expect(isRecognized("true")).toBe(false);
  });
});

describe("the cookie carries a marker and no person (#123 AC 6)", () => {
  it("is a single byte that says nothing about who signed in", () => {
    expect(RECOGNITION_VALUE).toBe("1");
    // The claim the criterion actually makes: no address, no name, no identifier. Asserted as a
    // property of the value rather than as a list of things it happens not to contain — a
    // `not.toContain("@")` would pass on a value carrying a user id.
    expect(RECOGNITION_VALUE).toMatch(/^[01]$/);
  });

  it("is httpOnly, lax, path /, and lives for twelve months", () => {
    expect(recognitionOptions(true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: RECOGNITION_MAX_AGE_S,
    });
    // Months, and the number is load-bearing: a member who last sailed in September and comes
    // back in May must still be recognised, so anything shorter than a winter defeats the story.
    expect(RECOGNITION_MAX_AGE_S).toBe(365 * 24 * 60 * 60);
    expect(RECOGNITION_MAX_AGE_S / (30 * 24 * 60 * 60)).toBeGreaterThan(6);
    // Chrome truncates anything past 400 days, so a longer life would be a number that is not
    // honoured rather than a longer memory.
    expect(RECOGNITION_MAX_AGE_S).toBeLessThanOrEqual(400 * 24 * 60 * 60);
  });

  it("takes `secure` from the request's protocol, as the gate pass does", () => {
    // Hard-coding `secure: true` would make the browser drop the cookie over plain http, so
    // recognition would silently never work on a local stack while reading correctly in the
    // source. src/auth/pass.ts is the shape being followed.
    expect(recognitionOptions(false).secure).toBe(false);
    expect(recognitionOptions(true).secure).toBe(true);
  });
});

describe("rememberDevice writes that one cookie and nothing else (#123 AC 4)", () => {
  it("sets the marker under the marker's name with the marker's options", () => {
    const written: Array<[string, string, unknown]> = [];
    rememberDevice({ set: (n, v, o) => written.push([n, v, o]) }, true);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual([RECOGNITION_COOKIE, RECOGNITION_VALUE, recognitionOptions(true)]);
  });

  it("passes the protocol through rather than deciding it", () => {
    const written: RecognitionOptions[] = [];
    rememberDevice({ set: (_n, _v, o) => written.push(o) }, false);
    expect(written[0].secure).toBe(false);
  });
});
