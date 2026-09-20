/**
 * The build stamp (#169): what a page says about the build that rendered it.
 *
 * The four values are inlined by `next.config.ts` at build time; this module reads them back and
 * makes the one decision about how they are shown. `BuildStamp.tsx` renders the result.
 */

/** Vercel's production branch (README, *Branches and deploys*). On it, the branch is not shown. */
export const PRODUCTION_REF = "release";

export type BuildStamp = {
  /** `package.json`'s `version`; null when the build was not stamped at all. */
  version: string | null;
  /** Short commit, or null when neither Vercel nor git could say. */
  sha: string | null;
  /** Branch built from, or null when unknown. */
  ref: string | null;
  /** ISO 8601 instant the config was evaluated, or null when unstamped. */
  builtAt: string | null;
};

/** What the footer prints: each part already decided, null meaning "omit". */
export type StampReading = {
  version: string | null;
  sha: string | null;
  /** The branch, but only off `release` — on production it is noise, everywhere else it is the point. */
  ref: string | null;
  /** The build date, `YYYY-MM-DD`, for the visible text; `builtAt` keeps the instant for `<time>`. */
  date: string | null;
  builtAt: string | null;
};

/**
 * Reads the inlined values. Each `process.env.NEXT_PUBLIC_…` is spelled out literally because that
 * is the form Next.js replaces at build time; a lookup through a variable key would survive the
 * build unreplaced and read the runtime environment instead.
 */
export function readStamp(): BuildStamp {
  return {
    version: process.env.NEXT_PUBLIC_BUILD_VERSION || null,
    sha: process.env.NEXT_PUBLIC_BUILD_SHA || null,
    ref: process.env.NEXT_PUBLIC_BUILD_REF || null,
    builtAt: process.env.NEXT_PUBLIC_BUILD_AT || null,
  };
}

export function describeStamp(stamp: BuildStamp): StampReading {
  return {
    version: stamp.version,
    sha: stamp.sha,
    ref: stamp.ref && stamp.ref !== PRODUCTION_REF ? stamp.ref : null,
    date: stamp.builtAt ? stamp.builtAt.slice(0, 10) : null,
    builtAt: stamp.builtAt,
  };
}
