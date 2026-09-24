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
 *
 * Since #243, 0035 replaces rotate_invite_code()'s body: a 30-character alphabet with no 0 or 1,
 * bytes 6 and 8 of each UUID skipped, and rejection sampling. Every test here runs against that
 * body, which is how the anon and 42501 cases above prove 0035's `create or replace` kept 0003's
 * grants (#243 AC 3). The last two describes are #243's own.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";
const SEED = "rotate-me";
/** 0035's alphabet: 2–9 and A–Z without I, L, O and U. Sorted, so a sorted set can be compared to it. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE = new RegExp(`^[${ALPHABET}]{8}$`);

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
      // a real draw does it once in 30^7.
      expect(new Set(code).size, code).toBeGreaterThan(1);
      seen.add(code);
      for (const ch of code) letters.add(ch);
    }
    expect(seen.size).toBe(20);
    // 160 draws from a 30-letter alphabet; a byte read off the same offset every time, or a
    // constant, would show as a handful of letters. (P(fewer than 16 distinct) is negligible.)
    expect(letters.size).toBeGreaterThanOrEqual(16);
  });
});

/**
 * `n` rotations as the admin, in statements of 1,000. One statement of 20,000 took 19 s where 20
 * of 1,000 took 4.4 s (measured): every update inside one statement leaves a dead version of the
 * club row that the next `select … from club` walks past, so the cost grows with the square.
 */
async function draw(n: number): Promise<string[]> {
  const codes: string[] = [];
  for (let done = 0; done < n; done += 1000) {
    const batch = Math.min(1000, n - done);
    const r = await as(db, "authenticated", `select public.rotate_invite_code() as code from generate_series(1, ${batch})`, ADMIN);
    for (const row of r.rows) codes.push((row as { code: string }).code);
  }
  return codes;
}

describe("invite code (0035) — #243 AC 1: no 0 or 1, and every character at every position", () => {
  it("1,000 rotations: 8 characters from the 30, none of 0, 1, I, L, O or U, all 30 at each of the 8 positions", async () => {
    const codes = await draw(1000);
    expect(codes).toHaveLength(1000);
    expect(codes.filter((c) => !CODE.test(c))).toEqual([]);
    expect(codes.filter((c) => /[01ILOU]/.test(c))).toEqual([]);
    // The per-position half is what 0003 fails: its 7th character came from byte 6, the UUID's
    // version byte, so it was only ever 0–9 or A–F. A pooled check cannot see one bad position
    // among eight good ones. By chance a character goes missing from a position here about once
    // in 10^12 runs (30 × 8 × (29/30)^1000).
    const missing = Array.from({ length: 8 }, (_, p) => {
      const seen = new Set(codes.map((c) => c[p]));
      return `${p + 1}: ${[...ALPHABET].filter((ch) => !seen.has(ch)).join("")}`;
    }).filter((line) => !line.endsWith(": "));
    expect(missing).toEqual([]);
  });
});

/**
 * Pearson's χ² for how `chars` spread over the 30 against an even spread. A character outside the
 * alphabet counts for nothing, so an alphabet change reads as its missing letters.
 */
function chiSquare(chars: string[]): number {
  const counts = new Map<string, number>();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const expected = chars.length / ALPHABET.length;
  let x = 0;
  for (const ch of ALPHABET) x += ((counts.get(ch) ?? 0) - expected) ** 2 / expected;
  return x;
}

/**
 * The bar: 29 degrees of freedom, and P(χ² ≥ 100) is 9.8 × 10⁻¹⁰ for a truly even draw (the
 * regularised incomplete gamma, computed), so the nine readings below give a false red about once
 * in 10^8 runs.
 */
const CHI_BAR = 100;

describe("invite code (0035) — the draw is even: the skipped bytes and the rejection (#243)", () => {
  it("the bar is crossed by exactly the bias `byte % 30` carries without rejection, and an even spread reads 0", () => {
    // Every byte value 200 times, reduced as 0035 would without its `>= 240` line: the first 16
    // characters get 9 in 256, the other 14 get 8. This is the control that the statistic and the
    // bar can see the defect the rejection exists to remove.
    const unrejected = Array.from({ length: 256 * 200 }, (_, i) => ALPHABET[(i % 256) % 30]);
    expect(chiSquare(unrejected)).toBeGreaterThan(CHI_BAR);
    expect(chiSquare(Array.from({ length: 3000 }, (_, i) => ALPHABET[i % 30]))).toBe(0);
  });

  it("20,000 rotations: no position, and not the pool, departs from an even spread over the 30", async () => {
    // Why each reading is here, and what it catches (simulated before it was written):
    //   - byte 6 read after all (the version byte, 0x40–0x4F): the position it lands on sees 16
    //     of the 30, far over the bar;
    //   - byte 8 read after all (the variant byte, 0x80–0xBF): % 30 gives four characters 3 in 64
    //     and the rest 2 in 64, which lands at the 8th position about two times in three — caught
    //     in 400 of 400 simulated runs at this size, 92% at 10,000;
    //   - the rejection removed: 9-in-256 against 8-in-256 is too small for one position (λ ≈ 68)
    //     and certain in the pool of 160,000 characters (λ ≈ 547).
    const codes = await draw(20_000);
    const readings = [
      ...Array.from({ length: 8 }, (_, p) => ({ where: `position ${p + 1}`, x: chiSquare(codes.map((c) => c[p])) })),
      { where: "pooled", x: chiSquare(codes.flatMap((c) => [...c])) },
    ];
    expect(readings.filter((r) => r.x >= CHI_BAR).map((r) => `${r.where}: χ² = ${r.x.toFixed(1)}`)).toEqual([]);
  }, 90_000);
});
