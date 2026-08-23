import { describe, expect, it } from "vitest";
import { PASS_TTL_MS, signPass, verifyPass, type PassPayload } from "./pass";

const secret = "test-secret-0123456789";
const issued = new Date("2026-08-23T10:00:00.000Z");
const payload: PassPayload = {
  display_name: "Bob",
  adult_attested_at: issued.toISOString(),
  issued_at: issued.toISOString(),
};

describe("the gate pass — sign and verify (#70 AC 4)", () => {
  it("round-trips within the TTL", () => {
    const token = signPass(payload, secret);
    expect(verifyPass(token, secret, new Date(issued.getTime() + 60_000))).toEqual(payload);
  });

  it("verifies false once expired — the TTL is at most 10 minutes", () => {
    expect(PASS_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
    const token = signPass(payload, secret);
    expect(verifyPass(token, secret, new Date(issued.getTime() + PASS_TTL_MS + 1))).toBeNull();
    // And a pass from the future is not a pass either.
    expect(verifyPass(token, secret, new Date(issued.getTime() - 1))).toBeNull();
  });

  it("verifies false when tampered with", () => {
    const token = signPass(payload, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, display_name: "Eve" })).toString("base64url");
    expect(verifyPass(`${forged}.${sig}`, secret, issued)).toBeNull();
    // A flipped signature byte, a missing dot, and an empty token.
    const badSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyPass(`${body}.${badSig}`, secret, issued)).toBeNull();
    expect(verifyPass(body, secret, issued)).toBeNull();
    expect(verifyPass("", secret, issued)).toBeNull();
    expect(verifyPass(undefined, secret, issued)).toBeNull();
  });

  it("verifies false when signed with another secret", () => {
    const token = signPass(payload, "some-other-secret");
    expect(verifyPass(token, secret, issued)).toBeNull();
    // An empty secret on either side is refused outright, never a wildcard.
    expect(() => signPass(payload, "")).toThrow(/secret/);
    expect(verifyPass(signPass(payload, secret), "", issued)).toBeNull();
  });

  it("verifies false when the payload is not the pass shape — with a valid issued_at, so only the shape guard can refuse it", async () => {
    const { createHmac } = await import("node:crypto");
    const signed = (p: unknown) => {
      const body = Buffer.from(JSON.stringify(p)).toString("base64url");
      return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
    };
    // Each fixture carries a parseable issued_at inside the TTL, so the NaN check cannot be what
    // rejects it (the review measured the earlier fixture passing on NaN with the guard deleted).
    expect(verifyPass(signed({ display_name: "Bob", issued_at: payload.issued_at }), secret, issued)).toBeNull();
    expect(
      verifyPass(signed({ display_name: 7, adult_attested_at: payload.adult_attested_at, issued_at: payload.issued_at }), secret, issued),
    ).toBeNull();
    expect(verifyPass(signed("a string"), secret, issued)).toBeNull();
    // And the positive control beside them: the same signer with the full shape verifies.
    expect(verifyPass(signed(payload), secret, issued)).toEqual(payload);
  });

  it("an empty secret never reaches the MAC — the guard, not a mismatch, is what refuses it", async () => {
    // A null from verifyPass cannot say WHY; createHmac accepts a zero-length key and would merely
    // mismatch. Inject the HMAC to assert the mechanism the comment above claims.
    const { createHmac } = await import("node:crypto");
    const { verifyPassWith } = await import("./pass");
    const calls: string[] = [];
    const spy: typeof createHmac = (alg, key, opts) => {
      calls.push(String(key));
      return createHmac(alg, key, opts);
    };
    const token = signPass(payload, secret);
    expect(verifyPassWith(token, "", issued, spy)).toBeNull();
    expect(calls).toEqual([]);
    expect(verifyPassWith(token, secret, issued, spy)).toEqual(payload);
    expect(calls).toEqual([secret]);
  });
});
