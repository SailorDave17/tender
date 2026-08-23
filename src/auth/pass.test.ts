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

  it("verifies false when the payload is not the pass shape", async () => {
    const body = Buffer.from(JSON.stringify({ display_name: "Bob" })).toString("base64url");
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifyPass(`${body}.${sig}`, secret, issued)).toBeNull();
  });
});
