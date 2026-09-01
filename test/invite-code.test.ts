import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0003 — rotate_invite_code() and current_invite_code(). Story #16 AC 1: an admin rotates the
 * club's invite code through the definer function and gets the new 8-character code back;
 * current_invite_code() returns it; anyone who is not an admin is refused and the code is
 * unchanged.
 *
 * Every deny is against `authenticated` with a positive control on the same mechanism beside
 * it. The anon case is on the functions' execute grant, and 0003 revokes it from anon BY NAME
 * because on the live project anon holds execute on every new function directly (measured
 * 2026-08-22). Since story #48 the harness reproduces that by-name grant, so the two anon denies
 * below are load-bearing rather than vacuous: they fail if 0003's revoke is removed.
 *
 * The fixture is shared down the file and the code's value is carried forward between tests:
 * a deny that fails to refuse would rotate the code and every later read reddens with it.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";
const SEED = "rotate-me";
/** 0003's alphabet: 0–9 and A–Z without I, L, O and U. */
const CODE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

const rotate = `select public.rotate_invite_code() as code`;
const current = `select public.current_invite_code() as code`;
const stored = () => db.query<{ invite_code: string }>(`select invite_code from public.club`);

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', '${SEED}');
    insert into auth.users (id) values ('${ADMIN}'), ('${CREW}');
    insert into public.person (id, display_name, adult_attested_at, is_admin) values
      ('${ADMIN}', 'Ada', now(), true),
      ('${CREW}', 'Cy', now(), false);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("invite code (0003) — shape and grants", () => {
  it("both functions are parameter-free definers with search_path pinned", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean; pronargs: number; proconfig: string[]; provolatile: string }>(
      `select proname, prosecdef, pronargs, proconfig, provolatile from pg_proc
        where oid in ('public.rotate_invite_code()'::regprocedure, 'public.current_invite_code()'::regprocedure)
        order by proname`,
    );
    expect(r.rows).toEqual([
      { proname: "current_invite_code", prosecdef: true, pronargs: 0, proconfig: ['search_path=""'], provolatile: "s" },
      { proname: "rotate_invite_code", prosecdef: true, pronargs: 0, proconfig: ['search_path=""'], provolatile: "v" },
    ]);
  });

  it("anon may not call either; authenticated reaches the body (and is refused there when not an admin)", async () => {
    await expect(as(db, "anon", rotate)).rejects.toThrow(/permission denied for function rotate_invite_code/);
    await expect(as(db, "anon", current)).rejects.toThrow(/permission denied for function current_invite_code/);
    // Positive control: the grant admits a signed-in person — the body's own check is what refuses.
    await expect(as(db, "authenticated", rotate, CREW)).rejects.toThrow(/not an admin/);
    await expect(as(db, "authenticated", current, CREW)).rejects.toThrow(/not an admin/);
  });

  it("no client role can update club.invite_code directly — the function is the only writer", async () => {
    await expect(
      as(db, "authenticated", `update public.club set invite_code = 'mine'`, ADMIN),
    ).rejects.toThrow(/permission denied for table club/);
    expect((await stored()).rows).toEqual([{ invite_code: SEED }]);
  });
});

describe("invite code (0003) — AC 1: admin-only, replaced in one call, returned", () => {
  let first = "";

  it("a non-admin's rotate raises 42501 and the code is unchanged; so does their current", async () => {
    await expect(as(db, "authenticated", rotate, CREW)).rejects.toMatchObject({ message: expect.stringMatching(/not an admin/) });
    await expect(as(db, "authenticated", current, CREW)).rejects.toThrow(/not an admin/);
    expect((await stored()).rows).toEqual([{ invite_code: SEED }]);
  });

  it("a call with no signed-in person raises too, and the code is unchanged", async () => {
    await expect(as(db, "authenticated", rotate)).rejects.toThrow(/not an admin/);
    expect((await stored()).rows).toEqual([{ invite_code: SEED }]);
  });

  it("the refusal is insufficient_privilege (42501), not a generic error", async () => {
    const err = await as(db, "authenticated", rotate, CREW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe("42501");
  });

  it("the admin rotates: an 8-character code from the alphabet is stored and returned", async () => {
    const r = await as(db, "authenticated", rotate, ADMIN);
    first = (r.rows[0] as { code: string }).code;
    expect(first).toMatch(CODE);
    expect(first).not.toBe(SEED);
    expect((await stored()).rows).toEqual([{ invite_code: first }]);
  });

  it("current_invite_code() returns what rotate stored, to the admin only", async () => {
    const r = await as(db, "authenticated", current, ADMIN);
    expect(r.rows).toEqual([{ code: first }]);
    await expect(as(db, "authenticated", current, CREW)).rejects.toThrow(/not an admin/);
  });

  it("rotating again replaces the code with a different one, and current follows", async () => {
    const r = await as(db, "authenticated", rotate, ADMIN);
    const second = (r.rows[0] as { code: string }).code;
    expect(second).toMatch(CODE);
    expect(second).not.toBe(first);
    expect((await stored()).rows).toEqual([{ invite_code: second }]);
    expect((await as(db, "authenticated", current, ADMIN)).rows).toEqual([{ code: second }]);
  });

  it("the draw is not degenerate: twenty rotations give twenty distinct codes using more than a few letters", async () => {
    const seen = new Set<string>();
    const letters = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const code = ((await as(db, "authenticated", rotate, ADMIN)).rows[0] as { code: string }).code;
      expect(code).toMatch(CODE);
      // A code of one repeated letter is what reading the same byte eight times produces;
      // a real draw does it once in 32^7.
      expect(new Set(code).size, code).toBeGreaterThan(1);
      seen.add(code);
      for (const ch of code) letters.add(ch);
    }
    expect(seen.size).toBe(20);
    // 160 draws from a 32-letter alphabet; a byte read off the same offset every time, or a
    // constant, would show as a handful of letters. (P(fewer than 16 distinct) is negligible.)
    expect(letters.size).toBeGreaterThanOrEqual(16);
  });
});
