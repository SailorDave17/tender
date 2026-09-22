import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { ERROR_EMAIL_WINDOW_MS } from "@/notify/error";
import { as, freshDb } from "./pglite";

/**
 * 0030 — error_report_claim and claim_error_report() (story #198): the error reporter's window,
 * taken as a write the database arbitrates rather than read and then acted on.
 *
 * ## What this file can and cannot prove
 *
 * pglite is ONE connection, so two claims here never truly overlap, and the property the claim
 * exists for (two concurrent callers, exactly one wins) is Postgres's `insert … on conflict do
 * update … where` row lock, not something this harness can race. What it holds is everything that
 * lock is applied TO: who may call it, what a claim answers, where the window's boundary falls, and
 * that a loser changes nothing. The concurrent half is measured on a real Postgres and recorded on
 * the story, not reasoned here.
 *
 * ## The instants are literals
 *
 * As for 0026, the caller sends both instants, so nothing here is relative to the wall clock.
 * `since` is always `at` minus the reporter's own window, computed from the constant rather than
 * restated, so the boundary cases move if the window does.
 */

const T0 = "2026-09-22T00:56:09.804Z";
const iso = (msFromT0: number) => new Date(new Date(T0).getTime() + msFromT0).toISOString();
const since = (atIso: string) => new Date(new Date(atIso).getTime() - ERROR_EMAIL_WINDOW_MS).toISOString();

const claim = (signature: string, atIso: string) =>
  `select won, held_since from public.claim_error_report('${signature}', '${atIso}'::timestamptz, '${since(atIso)}'::timestamptz)`;

type Claim = { won: boolean; held_since: Date };

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

async function claimAs(signature: string, atIso: string): Promise<Claim> {
  const r = await as(db, "service_role", claim(signature, atIso));
  expect(r.rows, "one row per claim").toHaveLength(1);
  return r.rows[0] as Claim;
}

async function heldAt(signature: string): Promise<string | null> {
  const r = await db.query<{ claimed_at: Date }>(`select claimed_at from public.error_report_claim where signature = $1`, [signature]);
  return r.rows[0] ? r.rows[0].claimed_at.toISOString() : null;
}

describe("0030 — shape and grants", () => {
  it("is an invoker's-rights, volatile function with search_path pinned and three named inputs", async () => {
    const r = await db.query<{ prosecdef: boolean; proconfig: string[]; provolatile: string; args: string }>(
      `select prosecdef, proconfig, provolatile, pg_get_function_identity_arguments(oid) as args
         from pg_proc where oid = 'public.claim_error_report(text, timestamptz, timestamptz)'::regprocedure`,
    );
    expect(r.rows).toEqual([
      {
        prosecdef: false,
        proconfig: ['search_path=""'],
        provolatile: "v",
        args: "p_signature text, p_at timestamp with time zone, p_since timestamp with time zone",
      },
    ]);
  });

  it("anon and authenticated may not call it; the service role may", async () => {
    await expect(as(db, "anon", claim("grants probe", T0))).rejects.toThrow(/permission denied for function claim_error_report/);
    await expect(as(db, "authenticated", claim("grants probe", T0), "11111111-1111-4111-8111-111111111111")).rejects.toThrow(
      /permission denied for function claim_error_report/,
    );
    // Positive control on the same call: the refusals above are the grant, not a broken query.
    expect((await claimAs("grants probe", T0)).won).toBe(true);
  });

  it("no client role reads or writes the table; the service role does", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(as(db, role, `select count(*) from public.error_report_claim`)).rejects.toThrow(/permission denied for table error_report_claim/);
      await expect(
        as(db, role, `insert into public.error_report_claim (signature, claimed_at) values ('x', now())`),
      ).rejects.toThrow(/permission denied for table error_report_claim/);
    }
    const r = await as(db, "service_role", `select count(*)::int as n from public.error_report_claim where signature = 'grants probe'`);
    expect((r.rows[0] as { n: number }).n).toBe(1);
  });

  it("row level security is on, with no policy", async () => {
    const r = await db.query<{ rls: boolean; policies: number }>(
      `select c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.tablename = 'error_report_claim') as policies
         from pg_class c where c.oid = 'public.error_report_claim'::regclass`,
    );
    expect(r.rows).toEqual([{ rls: true, policies: 0 }]);
  });
});

describe("0030 — what a claim answers", () => {
  it("the first claim on a signature wins, and holds from its own instant", async () => {
    const c = await claimAs("TypeError /board", T0);
    expect(c.won).toBe(true);
    expect(c.held_since.toISOString()).toBe(T0);
    expect(await heldAt("TypeError /board")).toBe(T0);
  });

  it("a second claim inside the hour loses, is told the holder's instant, and changes nothing", async () => {
    const c = await claimAs("TypeError /board", iso(4));
    expect(c.won).toBe(false);
    expect(c.held_since.toISOString()).toBe(T0);
    expect(await heldAt("TypeError /board"), "the loser did not move the window").toBe(T0);
  });

  it("one millisecond short of the hour still loses", async () => {
    const c = await claimAs("TypeError /board", iso(ERROR_EMAIL_WINDOW_MS - 1));
    expect(c.won).toBe(false);
    expect(await heldAt("TypeError /board")).toBe(T0);
  });

  it("at exactly the hour it wins again and the window moves — the same boundary as the in-process `at - seen < window`", async () => {
    const c = await claimAs("TypeError /board", iso(ERROR_EMAIL_WINDOW_MS));
    expect(c.won).toBe(true);
    expect(c.held_since.toISOString()).toBe(iso(ERROR_EMAIL_WINDOW_MS));
    expect(await heldAt("TypeError /board")).toBe(iso(ERROR_EMAIL_WINDOW_MS));
  });

  it("signatures are independent: a claim on one never answers for another", async () => {
    expect((await claimAs("ClubThemeReadError loadClubTheme", iso(5))).won).toBe(true);
    expect((await claimAs("TypeError /post/[id]", iso(5))).won).toBe(true);
    expect((await claimAs("ClubThemeReadError loadClubTheme", iso(6))).won).toBe(false);
  });

  it("one row per signature however many claims — the table never needs pruning", async () => {
    const r = await db.query<{ signature: string; n: number }>(
      `select signature, count(*)::int as n from public.error_report_claim group by signature order by signature`,
    );
    expect(r.rows.every((row) => row.n === 1)).toBe(true);
    expect(r.rows.map((row) => row.signature)).toEqual(["ClubThemeReadError loadClubTheme", "TypeError /board", "TypeError /post/[id]", "grants probe"]);
  });

  it("an empty signature is refused by the table, not stored", async () => {
    await expect(as(db, "service_role", claim("", T0))).rejects.toThrow(/error_report_claim_signature_check/);
  });
});
