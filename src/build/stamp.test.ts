import { afterEach, describe, expect, it, vi } from "vitest";
import { describeStamp, PRODUCTION_REF, readStamp } from "./stamp";

/**
 * #169 AC 2, AC 3 and the decision half of AC 5. What the footer prints is decided here, from the
 * four inlined values, so the two arms of each rule can be shown side by side.
 *
 * Stated blind spot: none of this runs `next.config.ts`, which is where the values are computed.
 * That the config's `env` actually lands in a bundle is proved by `next build` and a grep of its
 * output, recorded on the PR, not by a test here.
 */
const FULL = { version: "0.1.0", sha: "3c7759e", ref: "feature/169-build-stamp", builtAt: "2026-09-19T14:03:22.000Z" };

describe("describeStamp: what the footer prints (#169)", () => {
  it("passes version, commit and the branch through, and cuts the date from the instant", () => {
    expect(describeStamp(FULL)).toEqual({
      version: "0.1.0",
      sha: "3c7759e",
      ref: "feature/169-build-stamp",
      date: "2026-09-19",
      builtAt: "2026-09-19T14:03:22.000Z",
    });
  });

  it("omits the branch on release and nowhere else (AC 3)", () => {
    expect(describeStamp({ ...FULL, ref: PRODUCTION_REF }).ref).toBeNull();
    expect(describeStamp({ ...FULL, ref: "develop" }).ref).toBe("develop");
    expect(describeStamp({ ...FULL, ref: "main" }).ref, "the backup branch is not production either").toBe("main");
  });

  it("carries an absent commit or branch as absent rather than as a word (AC 2)", () => {
    const bare = describeStamp({ version: "0.1.0", sha: null, ref: null, builtAt: FULL.builtAt });
    expect(bare.sha).toBeNull();
    expect(bare.ref).toBeNull();
    expect(bare.version).toBe("0.1.0");
    expect(bare.date).toBe("2026-09-19");
  });

  it("has no date for an unstamped build", () => {
    const none = describeStamp({ version: null, sha: null, ref: null, builtAt: null });
    expect(none).toEqual({ version: null, sha: null, ref: null, date: null, builtAt: null });
  });
});

describe("readStamp: the inlined values, read back", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads all four when the build set them", () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_VERSION", "0.1.0");
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "3c7759e");
    vi.stubEnv("NEXT_PUBLIC_BUILD_REF", "release");
    vi.stubEnv("NEXT_PUBLIC_BUILD_AT", "2026-09-19T14:03:22.000Z");
    expect(readStamp()).toEqual({ version: "0.1.0", sha: "3c7759e", ref: "release", builtAt: "2026-09-19T14:03:22.000Z" });
  });

  it("turns an empty value — git had no answer, Vercel had no variable — into null, not an empty string", () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_VERSION", "0.1.0");
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_REF", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_AT", "2026-09-19T14:03:22.000Z");
    expect(readStamp().sha).toBeNull();
    expect(readStamp().ref).toBeNull();
  });

  it("reads an unstamped process as all null", () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_VERSION", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_REF", "");
    vi.stubEnv("NEXT_PUBLIC_BUILD_AT", "");
    expect(readStamp()).toEqual({ version: null, sha: null, ref: null, builtAt: null });
  });
});
