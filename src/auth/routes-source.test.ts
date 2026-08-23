import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * Two route files carry the option AC 2 (#70) and AC 3 (#15) rest on, and no unit test reads a
 * route: `shouldCreateUser: false` on the magic-link send is what stops an unknown address
 * minting an attestation-less auth user and spending a Resend send. The #70 mutation pass could
 * only prove it live; this is the in-suite half (review finding, 2026-08-23). The source is the
 * only subject there is (cairn: a-guard-that-reads-source-must-survive-its-own-docs), so the
 * assertion is anchored on the `signInWithOtp({` call itself — a header comment mentioning the
 * option cannot satisfy it.
 */
const ROUTES = ["../app/api/signin/route.ts", "../app/api/join/route.ts"];

async function otpCall(rel: string): Promise<string> {
  const src = await readFile(new URL(rel, import.meta.url), "utf8");
  const start = src.indexOf("signInWithOtp({");
  expect(start, `${rel} calls signInWithOtp`).toBeGreaterThan(-1);
  const end = src.indexOf("});", start);
  return src.slice(start, end);
}

describe("the magic-link senders never create a user", () => {
  for (const rel of ROUTES) {
    it(`${rel}: the signInWithOtp call carries shouldCreateUser: false`, async () => {
      const call = await otpCall(rel);
      expect(call).toMatch(/shouldCreateUser:\s*false/);
      expect(call).not.toMatch(/shouldCreateUser:\s*true/);
    });
  }

  it("the sign-in route makes no other Supabase call — no invite code read, no createUser (AC 2)", async () => {
    const src = await readFile(new URL("../app/api/signin/route.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/supabaseAdmin|createUser|invite_code|from\("club"\)/);
    expect(src.match(/client\.auth\.\w+/g)).toEqual(["client.auth.signInWithOtp"]);
  });
});
