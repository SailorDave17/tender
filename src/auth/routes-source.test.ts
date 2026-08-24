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

/**
 * #74. The link route and the sign-in route both end in "redirect the browser to Google", so a
 * wrong wiring produces a working-looking flow that mints a second auth user for the same human
 * — the exact defect the story exists to remove. No unit test reads a route, and the two starters
 * differ by one identifier, so the source is the only subject there is.
 */
describe("the link route links and the sign-in route signs in (#74 AC 1)", () => {
  it("/auth/link/google starts a LINK — startGoogleLink is the only starter it names", async () => {
    const src = await readFile(new URL("../app/auth/link/google/route.ts", import.meta.url), "utf8");
    expect([...new Set(src.match(/startGoogle\w*/g))]).toEqual(["startGoogleLink"]);
    expect(src).not.toMatch(/signInWithOAuth/);
  });

  it("/auth/link/google snapshots the PKCE verifiers BEFORE the start, and restores on refusal", async () => {
    const src = await readFile(new URL("../app/auth/link/google/route.ts", import.meta.url), "utf8");
    expect(src).toMatch(/restoreVerifiers\(before, verifierCookies\(store\.getAll\(\)\)\)/);
    // Ordering is the whole mechanism: a snapshot taken after the start captures the damage
    // rather than what preceded it, and reads exactly as correct.
    const snap = src.indexOf("const before = verifierCookies");
    const start = src.indexOf("const decision = decideLinkStart");
    expect(snap, "the snapshot must exist").toBeGreaterThan(-1);
    expect(snap).toBeLessThan(start);
  });

  it("/auth/google still starts a SIGN-IN — startGoogle, not the linker (negative control)", async () => {
    const src = await readFile(new URL("../app/auth/google/route.ts", import.meta.url), "utf8");
    expect([...new Set(src.match(/startGoogle\w*/g))]).toEqual(["startGoogle"]);
    expect(src).not.toMatch(/linkIdentity/);
  });

  it("the callback chooses its exit by the flow marker, not by a caller's `next`", async () => {
    const src = await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
    // back() must resolve its path through backPathFor — a hard-coded "/join" there is the bug
    // this criterion is about: a signed-in member told to sign in.
    const back = src.slice(src.indexOf("const back ="), src.indexOf("const decision ="));
    expect(back).toMatch(/backPathFor\(flow\)/);
    expect(back).not.toMatch(/pathname = "\/join"/);
  });

  // The SUCCESS leg has the same problem and no unit test either: a link that worked must land on
  // the profile with its marker, not on whatever `next` the redirect carried. Added before the
  // mutation pass, which predicted zero red for this branch without it.
  it("a successful link lands on the profile with its marker, not on the caller's `next`", async () => {
    const src = await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
    const tail = src.slice(src.indexOf("const target ="));
    expect(tail).toMatch(/isLinkFlow\(flow\)\s*\?\s*LINK_DONE\s*:\s*next/);
  });

  /**
   * Everything above proves the flow works once it is STARTED. Nothing proved a member could
   * start it: /profile is a Server Component doing async reads, so no test in this repo renders
   * it, and deleting the control would leave the whole suite green. The page is the only subject
   * there is — same reasoning as the two route tests above.
   */
  it("/profile carries the control, and can explain what comes back to it (#74 AC 1)", async () => {
    const src = await readFile(new URL("../app/profile/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/href="\/auth\/link\/google"/);
    // read off the getUser() the page already made, so knowing costs no extra round trip
    expect(src).toMatch(/hasGoogleIdentity\(user\.identities\)/);
    // a link refusal returns HERE, so this page must be able to say what happened; the ?? is
    // what lets link.ts answer first without either module listing the other's keys
    expect(src).toMatch(/explainLinkReason\(error\)\s*\?\?\s*explainProfileRefusal\(error\)/);
  });
});
