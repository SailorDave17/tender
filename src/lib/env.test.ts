import { describe, expect, it } from "vitest";
import { THROWING_NAMES } from "../../scripts/server-env.mjs";
import { env } from "./env";

/**
 * Story #65 AC 1: a missing server env var fails with its NAME on it.
 *
 * No network and no process mutation — `env` takes the environment as an argument, so each case
 * is a fake object. That is the point of the injection: a test that wrote to process.env would
 * leak into every other file in the worker.
 *
 * The five names are not written out here. They are read from the same declared list check:live
 * prints, so a name added to the runbook and the registry is asserted by this file the moment it
 * lands, and a list that quietly loses one cannot leave a green test behind claiming otherwise.
 */
describe("env: a missing server name is reported by name (AC 1)", () => {
  const full = Object.fromEntries(THROWING_NAMES.map((n: string) => [n, `value-of-${n}`]));

  it("the declared throwing set is the four left after #173 retired the gate pass", () => {
    // Spelled out ONCE, here, so the registry cannot silently drift from the acceptance
    // criterion it was written against. The story named five; #173 retired the gate-pass secret
    // with the Google redirect flow. A fifth throwing name is a deliberate edit to this line.
    expect(THROWING_NAMES).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "RESEND_API_KEY",
    ]);
  });

  it("returns the value when it is set", () => {
    for (const name of THROWING_NAMES) expect(env(name, full)).toBe(`value-of-${name}`);
  });

  for (const name of THROWING_NAMES as string[]) {
    it(`names ${name} when it is unset`, () => {
      const { [name]: _gone, ...without } = full;
      expect(() => env(name, without)).toThrow(`${name} is not set`);
    });

    it(`names ${name} when it is empty`, () => {
      // A Vercel variable created and left blank is the likelier mistake than one never created,
      // and the two must not be distinguishable to the reader of the log line.
      expect(() => env(name, { ...full, [name]: "" })).toThrow(`${name} is not set`);
    });
  }

  it("reports the name asked for, not the first one missing", () => {
    // The message is built from the argument, so a reader can trust it. Mutating env() to throw
    // a fixed string would pass every case above and fail this one.
    const empty = {};
    expect(() => env("SUPABASE_SERVICE_ROLE_KEY", empty)).toThrow("SUPABASE_SERVICE_ROLE_KEY is not set");
    expect(() => env("RESEND_API_KEY", empty)).toThrow("RESEND_API_KEY is not set");
  });
});
