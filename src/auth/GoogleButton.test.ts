import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GSI_SCRIPT, makeNonce } from "./GoogleButton";

/**
 * #173 AC 6, the browser's half. Supabase compares the token's `nonce` claim — which Google sets
 * to whatever GIS was given — against the SHA-256 of the raw value the route sends, in hex. So
 * the one contract this component owns is: hand GIS the hex SHA-256, hand the route the raw
 * value, and make the raw value fresh. Everything else in the file is Google's iframe.
 */
describe("makeNonce — the hash goes to Google, the raw value goes to our route", () => {
  it("hashed is the hex SHA-256 of raw, and raw is 32 random bytes in base64", async () => {
    const { raw, hashed } = await makeNonce();
    expect(hashed).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(raw, "base64").length).toBe(32);
  });

  it("uses the injected randomness and digest, so the contract above is about the wiring", async () => {
    const seen: Uint8Array[] = [];
    const digested: string[] = [];
    const { raw, hashed } = await makeNonce(
      (b) => {
        b.fill(7);
        seen.push(b);
        return b;
      },
      async (d) => {
        digested.push(Buffer.from(d).toString("utf8"));
        return createHash("sha256").update(d).digest().buffer as ArrayBuffer;
      },
    );
    expect(seen).toHaveLength(1);
    expect(raw).toBe(Buffer.alloc(32, 7).toString("base64"));
    // the digest is fed the RAW value's UTF-8 bytes, not the random bytes
    expect(digested).toEqual([raw]);
    expect(hashed).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("is fresh per call — two nonces never agree", async () => {
    const a = await makeNonce();
    const b = await makeNonce();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hashed).not.toBe(b.hashed);
  });

  it("loads GIS from Google's own host, on https", () => {
    expect(GSI_SCRIPT).toBe("https://accounts.google.com/gsi/client");
  });
});
