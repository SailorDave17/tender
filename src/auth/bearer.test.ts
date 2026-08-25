import { describe, expect, it } from "vitest";
import { bearerAuthorized } from "./bearer";

/**
 * The tick route's credential (story #25 AC 5). Every case here is a refusal except two, which
 * is the right shape for a guard: the interesting claims are the ones about what does NOT get in.
 */

const SECRET = "s3cr3t-cron-value-long-enough-to-be-real";

describe("bearerAuthorized", () => {
  it("accepts exactly the configured secret, and the scheme is case-insensitive as RFC 7235 says", () => {
    expect(bearerAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerAuthorized(`bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("refuses a wrong secret, including one that is a prefix or an extension of the right one", () => {
    expect(bearerAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerAuthorized(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(bearerAuthorized("Bearer something-else", SECRET)).toBe(false);
  });

  it("refuses a missing header, an empty one, a bare token and the wrong scheme", () => {
    expect(bearerAuthorized(null, SECRET)).toBe(false);
    expect(bearerAuthorized(undefined, SECRET)).toBe(false);
    expect(bearerAuthorized("", SECRET)).toBe(false);
    expect(bearerAuthorized(SECRET, SECRET)).toBe(false); // no scheme
    expect(bearerAuthorized(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(bearerAuthorized("Bearer", SECRET)).toBe(false);
    expect(bearerAuthorized("Bearer ", SECRET)).toBe(false);
  });

  /**
   * The case the function exists for. A deployment where CRON_SECRET was never set must refuse
   * everything, including a caller who presents nothing — the natural inline spelling
   * (`secret && header !== …`) would let the whole world run the tick there, and every preview
   * deployment is exactly that deployment.
   */
  it("refuses everything when no secret is configured — including an empty-string secret", () => {
    for (const secret of [undefined, ""]) {
      expect(bearerAuthorized(`Bearer ${SECRET}`, secret)).toBe(false);
      expect(bearerAuthorized("Bearer ", secret)).toBe(false);
      expect(bearerAuthorized("Bearer " + secret, secret)).toBe(false);
      expect(bearerAuthorized(null, secret)).toBe(false);
    }
  });
});
