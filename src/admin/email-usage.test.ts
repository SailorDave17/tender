import { describe, expect, it } from "vitest";
import { AMBER_PERCENT, RED_PERCENT, loadEmailUsage, usageLevel } from "./email-usage";
import { EMAIL_ATTEMPT_KINDS } from "@/notify/kinds";
import { EMAIL_DAY_CAP, EMAIL_MONTH_CAP, emailDayStart, emailMonthStart } from "@/notify/rung";

/**
 * Story #39 AC 1's thresholds: amber at 70, red at 90 — of a 100 cap, so the rule is a percentage
 * and the monthly 3,000 gets the same one.
 *
 * Every case here is a BOUNDARY. A threshold tested at 50 and 95 is tested nowhere: the only
 * values that can distinguish `>=` from `>`, or an off-by-one in the arithmetic, are the two on
 * either side of each line. The monthly pair is not a repetition of the daily pair, because a
 * percentage rule can be right at 100 and wrong at 3,000 — a scaling bug has no boundary to trip
 * over on a cap that IS 100.
 *
 * One case below records a NEGATIVE result rather than asserting behaviour: `usageLevel` uses
 * integer arithmetic, and the first draft of this file claimed that was repairing a float error.
 * It was not. The case now measures the two forms agreeing, which is the true fact and the one
 * worth keeping — a test asserting a trap that does not exist would have to be deleted the first
 * time anyone checked it.
 */

describe("usageLevel — the thresholds AC 1 names", () => {
  const day = (n: number) => usageLevel(n, EMAIL_DAY_CAP);
  const month = (n: number) => usageLevel(n, EMAIL_MONTH_CAP);

  it("the percentages are the ones the AC names", () => {
    expect([AMBER_PERCENT, RED_PERCENT]).toEqual([70, 90]);
  });

  it("the daily cap: green below 70, amber from 70, red from 90", () => {
    expect([day(0), day(69), day(70), day(89), day(90), day(100), day(137)]).toEqual([
      "ok",
      "ok",
      "amber",
      "amber",
      "red",
      "red",
      "red", // past the cap is still red; there is nothing louder to say
    ]);
  });

  it("the monthly cap: the same rule, at 2,100 and 2,700", () => {
    expect([month(2_099), month(2_100), month(2_699), month(2_700)]).toEqual([
      "ok",
      "amber",
      "amber",
      "red",
    ]);
  });

  it("the integer form and the float form agree for every cap from 1 to 5,000, at both thresholds", () => {
    // Measured, not assumed. The integer spelling in usageLevel is exact by construction, but it
    // is repairing nothing observable: there is no cap in this range where the float comparison
    // lands on the other side of its own threshold. Rewriting usageLevel the float way would
    // redden NOTHING in this file — which is precisely why the claim belongs here as a measured
    // equivalence rather than in a comment as a defect that was fixed.
    const disagreements: number[][] = [];
    for (let cap = 1; cap <= 5_000; cap++) {
      for (const pc of [AMBER_PERCENT, RED_PERCENT]) {
        const n = Math.ceil((cap * pc) / 100); // the first count at or over the threshold
        if (n * 100 >= cap * pc !== n >= cap * (pc / 100)) disagreements.push([cap, pc]);
      }
    }
    expect(disagreements).toEqual([]);
    // And this app's own two caps land on whole numbers, so neither is a near miss.
    expect([EMAIL_DAY_CAP * 0.7, EMAIL_MONTH_CAP * 0.7]).toEqual([70, 2_100]);
  });

  it("red wins where both thresholds are met", () => {
    // Ordering, not arithmetic: 90 of 100 is over 70 as well, and the sentence the screen prints
    // for red is the one that says sending will stop.
    expect(day(95)).toBe("red");
  });
});

describe("the windows the counts are taken over", () => {
  it("the day is UTC midnight, and the month is the first of the month at the same instant", () => {
    const now = new Date("2026-09-20T10:30:00Z");
    expect(emailDayStart(now).toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(emailMonthStart(now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("the last instant of a month and the first of the next are on opposite sides of the boundary", () => {
    expect(emailMonthStart(new Date("2026-09-30T23:59:59.999Z")).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(emailMonthStart(new Date("2026-10-01T00:00:00.000Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("January rolls the year, not only the month", () => {
    // `Date.UTC(y, m, 1)` with m = 0 — the case a month-arithmetic bug survives every other test.
    expect(emailMonthStart(new Date("2027-01-15T12:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

/**
 * `loadEmailUsage` against a recording fake, which is the only instrument that can see it.
 *
 * A pglite test cannot: it would re-spell the RPC as its own SQL and so measure Postgres rather
 * than this function (the #38 finding — deleting a loader's `.eq()` reddened nothing with 1166
 * green tests, and the repair was a fake exactly like this one). What this holds is the part
 * pglite never touches: the argument names PostgREST resolves the overload on, the two instants
 * derived from the page's single clock, and — the reason it matters most — that a failed read
 * comes back as a FAILURE and not as a count of zero.
 */
describe("loadEmailUsage — what it sends, and what it does with what comes back", () => {
  const NOW = new Date("2026-09-20T10:30:00Z");

  /** Records the one `.rpc(name, args)` call and answers with whatever it was given. */
  function fakeClient(answer: { data?: unknown; error?: { message: string } | null }) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: answer.data ?? null, error: answer.error ?? null };
      },
    };
    return { client: client as unknown as Parameters<typeof loadEmailUsage>[0], calls };
  }

  it("calls email_usage with the app's kind list and the day and month of the instant it was given", async () => {
    const { client, calls } = fakeClient({ data: [{ day_count: 7, month_count: 120 }] });
    await loadEmailUsage(client, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("email_usage");
    // The argument NAMES are what PostgREST resolves on; migrations-hygiene holds them against
    // the harness, and this holds them against the call that is actually made.
    expect(Object.keys(calls[0].args).sort()).toEqual(["p_day_start", "p_kinds", "p_month_start"]);
    expect(calls[0].args.p_kinds).toEqual(EMAIL_ATTEMPT_KINDS);
    expect(calls[0].args.p_day_start).toBe("2026-09-20T00:00:00.000Z");
    expect(calls[0].args.p_month_start).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns the counts and the caps on a successful read", async () => {
    const { client } = fakeClient({ data: [{ day_count: 7, month_count: 120 }] });
    expect(await loadEmailUsage(client, NOW)).toMatchObject({
      day: 7,
      month: 120,
      dayCap: EMAIL_DAY_CAP,
      monthCap: EMAIL_MONTH_CAP,
      error: null,
    });
  });

  it("a refused read is an ERROR, never a count of zero", async () => {
    // The whole point. "0 of 100 emails sent today" is the most reassuring thing this screen can
    // print and would be a lie told at the moment the admin most needs the truth — so the zeros
    // below are inert and `error` is what the component renders.
    const { client } = fakeClient({ error: { message: "permission denied for function email_usage" } });
    const usage = await loadEmailUsage(client, NOW);
    expect(usage.error).toBe("permission denied for function email_usage");
    expect([usage.day, usage.month]).toEqual([0, 0]);
  });

  it("an empty result set is a failed read too, not a quiet zero", async () => {
    // `returns table` always yields one row (test/email-usage.test.ts proves it), so this arm
    // should be unreachable — which is exactly why it must not be spelled as `?? 0`.
    const { client } = fakeClient({ data: [] });
    const usage = await loadEmailUsage(client, NOW);
    expect(usage.error).toMatch(/returned no row/);
    expect([usage.day, usage.month]).toEqual([0, 0]);
  });

  it("null data with no error is a failed read as well", async () => {
    const { client } = fakeClient({ data: null });
    expect((await loadEmailUsage(client, NOW)).error).toMatch(/returned no row/);
  });
});
