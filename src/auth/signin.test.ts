import { describe, expect, it } from "vitest";
import { GENERIC_OK, requestReset, type RequestResetDeps } from "./signin";

/**
 * The magic-link half of this file — `signIn` and `isNotAUser`, with four tests of their own —
 * was deleted by #99 along with the mechanism, rather than left passing over code nothing calls.
 * What is left is the Forgot screen's one arm.
 */
describe("requestReset — the Forgot screen's one arm (#82 AC 4, narrowed by #99)", () => {
  function resetFakes(overrides: Partial<RequestResetDeps> = {}) {
    const sent: string[] = [];
    const deps: RequestResetDeps = {
      sendReset: async (email) => {
        sent.push(email);
        return {};
      },
      ...overrides,
    };
    return { deps, sent };
  }

  it("sends the reset to the normalised address and answers the generic sentence", async () => {
    const { deps, sent } = resetFakes();
    const r = await requestReset({ email: " Alice@Example.org " }, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
    expect(sent).toEqual(["alice@example.org"]);
  });

  it("400 on a malformed address, before anything is sent", async () => {
    const { deps, sent } = resetFakes();
    expect((await requestReset({ email: "not-an-address" }, deps)).status).toBe(400);
    expect((await requestReset({ email: "" }, deps)).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("500 on a transport failure — resetPasswordForEmail does not surface an unknown address, so an error is real", async () => {
    const { deps } = resetFakes({ sendReset: async () => ({ error: { message: "smtp down" } }) });
    expect((await requestReset({ email: "alice@example.org" }, deps)).status).toBe(500);
  });

  /**
   * #99 moved GENERIC_OK here from join.ts and reworded it. The sign-up path no longer sends
   * anything, so a sentence promising a link would now be false everywhere it was once shared —
   * and this is the one arm that still sends, so it is the only one entitled to say it.
   */
  it("the sentence is about a reset, reveals nothing, and no longer promises a sign-in link", () => {
    expect(GENERIC_OK).toMatch(/reset/i);
    expect(GENERIC_OK).toMatch(/^If that address/); // still conditional: no address is confirmed
    expect(GENERIC_OK).not.toMatch(/sign[- ]in link|magic/i);
  });
});
