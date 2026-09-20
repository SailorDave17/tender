import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * The build stamp (#169). Four facts about THIS build, computed here — once, while `next build`
 * evaluates the config — and inlined through `env`, so every bundle carries the stamp of the build
 * that produced it. Reading them at request time instead would let a stale bundle report whatever
 * the process environment said at that moment, which is the one thing a stamp must not do.
 *
 * `src/build/stamp.ts` reads them back and decides how they are shown.
 */
function stdout(command: string): string {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/** `package.json`'s `version` is the one place the number lives; `README.md` says how to bump it. */
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };

/**
 * Vercel exposes the commit and branch it is building from; a Vercel build has no `.git` to ask.
 * A local build asks git. Neither present — a tarball, say — leaves the value empty, and the stamp
 * renders without it rather than the build failing over a footer.
 */
const sha = (process.env.VERCEL_GIT_COMMIT_SHA || stdout("git rev-parse --short=7 HEAD")).slice(0, 7);
const ref = process.env.VERCEL_GIT_COMMIT_REF || stdout("git rev-parse --abbrev-ref HEAD");

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_VERSION: version,
    NEXT_PUBLIC_BUILD_SHA: sha,
    NEXT_PUBLIC_BUILD_REF: ref,
    NEXT_PUBLIC_BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
