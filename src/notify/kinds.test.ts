import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_ATTEMPT_KINDS } from "./kinds";

/**
 * The one list of email-attempt kinds, held to the values the stores actually filter on.
 * `store.ts` imports `server-only` and cannot be imported here, so its text is read: every
 * `.in("kind", …)` in it must name exactly EMAIL_ATTEMPT_KINDS, and the list must be the eight
 * kinds by name — a list that drifts from either side is the defect the fan-out found on #37.
 *
 * `invite` joined on #31, and `error` on #43; they are the two kinds on this list NOT addressed
 * to a member. Each belongs here for the list's own reason rather than by analogy: the cap is
 * Resend's, which counts every send whoever it went to, so an attempt kind left off this list
 * would be free of the cap it is itself refused by.
 *
 * THE SCAN READS EVERY LIVE STORE, NOT store.ts ALONE (#43). The error reporter's store lives in
 * `error-live.ts` — its import graph has to stay small enough to load when the app is broken —
 * and a scan hard-coded to one filename would have gone on passing with a second store outside
 * its corpus. That is #37's finding (d) exactly: a guard that enumerates by name is only as
 * complete as its last edit, so this one enumerates by what is on disk.
 */

/** Every module under src/notify/ that imports `server-only`: the live stores, by definition. */
function liveStoreFiles(): string[] {
  const dir = join(process.cwd(), "src", "notify");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /^import "server-only";/m.test(readFileSync(join(dir, f), "utf8")))
    .sort();
}

describe("EMAIL_ATTEMPT_KINDS", () => {
  it("is the eight attempt kinds, by name", () => {
    expect([...EMAIL_ATTEMPT_KINDS].sort()).toEqual(["answer", "confirmed", "error", "invite", "match", "message", "morning_of", "rung_email"]);
  });

  it("is what every `.in(\"kind\", …)` in the live stores filters on", () => {
    const files = liveStoreFiles();
    // The corpus itself, asserted: a scan that found no files would pass the loop below in
    // silence, which is the shape this test was widened to avoid.
    expect(files).toEqual(["error-live.ts", "live.ts", "store.ts"]);
    const lists = files.flatMap((f) => [...readFileSync(join(process.cwd(), "src", "notify", f), "utf8").matchAll(/\.in\("kind",\s*([^)]*)\)/g)].map((m) => m[1].trim()));
    expect(lists.length).toBeGreaterThanOrEqual(5); // match, message, confirm, invite, error
    for (const l of lists) expect(l).toBe("EMAIL_ATTEMPT_KINDS");
  });
});
