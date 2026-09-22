import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live store's claim (story #198): what `claim_error_report` answers over PostgREST, turned
 * into the reporter's `WindowClaim`.
 *
 * `error-live.ts` imports `server-only`, which does not resolve outside Next, so that module is
 * mocked empty and the service-role client is a recording fake. The ARGUMENT NAMES are held
 * elsewhere, against the harness's `pg_proc` and every `.rpc()` in src/
 * (`test/migrations-hygiene.test.ts`); what only this file holds is the mapping back — that a
 * `returns table` answer is read as an array of rows, that `held_since` becomes a Date, and that
 * an error or an empty answer throws, sending the reporter down its best-effort path to the send.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/email/send", () => ({ resendTransport: () => ({ send: async () => ({ id: "re_x" }) }) }));

let answer: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const calls: { fn: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return answer;
    },
  }),
}));

const AT = new Date("2026-09-22T00:56:09.804Z");
const SINCE = new Date("2026-09-21T23:56:09.804Z");

beforeEach(() => {
  calls.length = 0;
});

describe("the in-process window is one per PROCESS, not one per copy of the module (#198)", () => {
  it("two fresh evaluations of the module — two route bundles — hold the same Map", async () => {
    // What a production build does: the manifest route handler measured its own copy of this
    // module beside the pages' one. `resetModules` makes the second import evaluate it afresh.
    vi.resetModules();
    const first = await import("./error-live");
    vi.resetModules();
    const second = await import("./error-live");
    expect(second).not.toBe(first); // two evaluations, or this proves nothing
    expect(second.recent).toBe(first.recent);
    first.recent.set("TypeError /probe", 1);
    expect(second.recent.get("TypeError /probe")).toBe(1);
    first.recent.delete("TypeError /probe");
  });
});

describe("supabaseErrorStore().claimWindow (#198)", () => {
  it("calls claim_error_report with the signature and both instants as ISO strings", async () => {
    answer = { data: [{ won: true, held_since: AT.toISOString() }], error: null };
    const { supabaseErrorStore } = await import("./error-live");
    await supabaseErrorStore().claimWindow("TypeError /board", AT, SINCE);
    expect(calls).toEqual([
      { fn: "claim_error_report", args: { p_signature: "TypeError /board", p_at: AT.toISOString(), p_since: SINCE.toISOString() } },
    ]);
  });

  it("a won claim maps to won, holding from its own instant", async () => {
    answer = { data: [{ won: true, held_since: AT.toISOString() }], error: null };
    const { supabaseErrorStore } = await import("./error-live");
    expect(await supabaseErrorStore().claimWindow("TypeError /board", AT, SINCE)).toEqual({ won: true, heldSince: AT });
  });

  it("a lost claim maps to lost, holding from the WINNER's instant", async () => {
    const winner = new Date("2026-09-22T00:30:00.000Z");
    answer = { data: [{ won: false, held_since: winner.toISOString() }], error: null };
    const { supabaseErrorStore } = await import("./error-live");
    expect(await supabaseErrorStore().claimWindow("TypeError /board", AT, SINCE)).toEqual({ won: false, heldSince: winner });
  });

  it("a PostgREST error throws, naming the claim — the reporter treats that as best-effort", async () => {
    answer = { data: null, error: { message: "JWT issued at future" } };
    const { supabaseErrorStore } = await import("./error-live");
    await expect(supabaseErrorStore().claimWindow("TypeError /board", AT, SINCE)).rejects.toThrow(/claim the window: JWT issued at future/);
  });

  it("an answer with no row throws rather than reading as either outcome", async () => {
    answer = { data: [], error: null };
    const { supabaseErrorStore } = await import("./error-live");
    await expect(supabaseErrorStore().claimWindow("TypeError /board", AT, SINCE)).rejects.toThrow(/no row came back/);
  });
});
