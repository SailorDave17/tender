import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_ATTEMPT_KINDS } from "./kinds";

/**
 * The one list of email-attempt kinds, held to the values the stores actually filter on.
 * `store.ts` imports `server-only` and cannot be imported here, so its text is read: every
 * `.in("kind", …)` in it must name exactly EMAIL_ATTEMPT_KINDS, and the list must be the six
 * kinds by name — a list that drifts from either side is the defect the fan-out found on #37.
 */
describe("EMAIL_ATTEMPT_KINDS", () => {
  it("is the six attempt kinds, by name", () => {
    expect([...EMAIL_ATTEMPT_KINDS].sort()).toEqual(["answer", "confirmed", "match", "message", "morning_of", "rung_email"]);
  });

  it("is what every `.in(\"kind\", …)` in the live stores filters on", () => {
    const text = readFileSync(join(process.cwd(), "src", "notify", "store.ts"), "utf8");
    const lists = [...text.matchAll(/\.in\("kind",\s*([^)]*)\)/g)].map((m) => m[1].trim());
    expect(lists.length).toBeGreaterThanOrEqual(3); // match, message, confirm
    for (const l of lists) expect(l).toBe("EMAIL_ATTEMPT_KINDS");
  });
});
