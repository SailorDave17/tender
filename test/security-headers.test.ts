import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "@/security/headers";
import nextConfig from "../next.config";
import { EXPECTED_SECURITY_HEADERS } from "../scripts/smoke-core.mjs";

/**
 * Story #207 — the baseline security headers, as configured. Whether a running build actually
 * SERVES them is the smoke's step "every kind of response carries the baseline security headers",
 * which reads them off one response of each kind on every pull request (CI's `smoke` job). That
 * needs a built server, and CI's `test` job runs before the build, so this file holds the half that
 * needs none: the rule's reach, and that the config and the smoke's statement of the policy agree.
 */
describe("the security headers next.config.ts applies (#207)", () => {
  it("applies SECURITY_HEADERS to every path, in one rule", async () => {
    // One rule on `/:path*`. A narrower source, or a second rule overriding a key for some path,
    // would leave responses without the policy; Next's own matching is the smoke's to prove.
    expect(await nextConfig.headers?.()).toEqual([{ source: "/:path*", headers: SECURITY_HEADERS }]);
  });

  it("is exactly the policy the smoke checks, with no header listed twice", () => {
    const keys = SECURITY_HEADERS.map((h) => h.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]))).toEqual(EXPECTED_SECURITY_HEADERS);
  });

  it("carries the two CSP directives the story names, as directives", () => {
    const csp = SECURITY_HEADERS.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    const directives = csp.split(";").map((d) => d.trim());
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("object-src 'none'");
  });

  it("leaves FedCM at its default, which Google's sign-in button uses (#173)", () => {
    // `identity-credentials-get=()` would switch off the browser API GIS signs in through on this
    // origin. Its default (`self`, delegable to Google's frame) is what the button needs.
    const policy = SECURITY_HEADERS.find((h) => h.key === "Permissions-Policy")?.value ?? "";
    expect(policy).toMatch(/camera=\(\)/);
    expect(policy).not.toMatch(/identity-credentials-get/);
  });
});
