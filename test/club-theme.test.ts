import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { MIN_CONTRAST, contrastRatio, isValidTheme } from "../src/brand/contrast";
import { HOOVER_SAILING_CLUB } from "../src/brand/theme";
import { as, freshDb } from "./pglite";

/**
 * 0028 — the club's pair, set by the admin with the 3:1 rule enforced at save (story #41 AC 2).
 *
 * Two claims. `contrast_ratio()` is the SAME rule as `src/brand/contrast.ts`, held equal on the
 * same pairs to within floating-point noise (the two run `pow` in different runtimes, so exact
 * equality is not the claim; agreement on every pair's side of 3.0 is). And `set_club_theme()`
 * is the ONLY writer of the pair and refuses in the order its header states: non-admin, then
 * non-colour, then the pair — each refusal read back against an unchanged row, so a refusal that
 * wrote first would be red.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";

/** The nearest grey pairs to 3.0 on either side (see src/brand/contrast.test.ts). */
const JUST_ABOVE = ["#242424", "#6D6D6D"] as const;
const JUST_BELOW = ["#1B1B1B", "#666666"] as const;

const call = (disc: string | null, mark: string | null) =>
  `select public.set_club_theme(${disc === null ? "null" : `'${disc}'`}, ${mark === null ? "null" : `'${mark}'`})`;

let db: PGlite;
const stored = () =>
  db.query<{ brand_disc: string; brand_mark: string }>(`select brand_disc, brand_mark from public.club`);
const ratio = async (a: string, b: string) =>
  (await db.query<{ r: number }>(`select public.contrast_ratio($1, $2) as r`, [a, b])).rows[0].r;

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '${HOOVER_SAILING_CLUB.disc}', '${HOOVER_SAILING_CLUB.mark}', 'seed');
    insert into auth.users (id) values ('${ADMIN}'), ('${CREW}');
    insert into public.person (id, display_name, adult_attested_at, is_admin) values
      ('${ADMIN}', 'Ada', now(), true),
      ('${CREW}', 'Cy', now(), false);
  `);
});
afterAll(async () => {
  await db.close();
});

describe("contrast_ratio (0028) — the SQL spelling of src/brand/contrast.ts", () => {
  it("reads the four values AC 1 names", async () => {
    expect(await ratio(HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark)).toBeCloseTo(4.13, 2);
    expect(await ratio("#395FAC", "#395FAC")).toBe(1);
    expect(await ratio("#000000", "#FFFFFF")).toBeCloseTo(21, 10);
    expect(await ratio(...JUST_ABOVE)).toBeGreaterThanOrEqual(3.0);
    expect(await ratio(...JUST_BELOW)).toBeLessThan(3.0);
  });

  it("agrees with the TypeScript ratio on every pair tried, and on which side of 3.0 each falls", async () => {
    const pairs: [string, string][] = [
      [HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark],
      [HOOVER_SAILING_CLUB.mark, HOOVER_SAILING_CLUB.disc], // symmetric
      ["#000000", "#FFFFFF"],
      ["#FFFFFF", "#FFFFFE"],
      ["#1E5443", "#EDF0EA"], // the retired hull-green pair
      ["#8A5A00", "#FFFFFF"],
      ["#B42318", "#121A17"],
      ["#7f7f7f", "#808080"], // lower case, either side of the 0.03928 knee's far end
      ["#0a0a0a", "#0b0b0b"], // both channels on the linear side of the knee
      [...JUST_ABOVE],
      [...JUST_BELOW],
    ];
    for (const [a, b] of pairs) {
      const sql = await ratio(a, b);
      const ts = contrastRatio(a, b);
      expect(sql, `${a} on ${b}`).toBeCloseTo(ts, 9);
      expect(sql >= MIN_CONTRAST, `${a} on ${b}: side of 3.0`).toBe(isValidTheme(a, b));
    }
  });

  it("refuses a non-colour, and a NULL, with 'colour' rather than answering NULL", async () => {
    await expect(ratio("navy", "#FFFFFF")).rejects.toThrow(/colour/);
    await expect(ratio("#FFF", "#FFFFFF")).rejects.toThrow(/colour/); // the row takes six digits only
    await expect(
      db.query(`select public.contrast_ratio(null, '#FFFFFF')`),
    ).rejects.toThrow(/colour/);
  });

  it("is immutable, invoker's rights, search_path pinned, and NOT strict", async () => {
    const r = await db.query<{ prosecdef: boolean; provolatile: string; proisstrict: boolean; proconfig: string[] }>(
      `select prosecdef, provolatile, proisstrict, proconfig from pg_proc
        where oid = 'public.contrast_ratio(text, text)'::regprocedure`,
    );
    // Strict would answer NULL for a NULL colour, and `NULL < 3.0` is a pass-through in plpgsql.
    expect(r.rows).toEqual([{ prosecdef: false, provolatile: "i", proisstrict: false, proconfig: ['search_path=""'] }]);
  });
});

describe("set_club_theme (0028) — the only writer, refusing in order", () => {
  it("is a definer with search_path pinned and two qualified text parameters", async () => {
    const r = await db.query<{ prosecdef: boolean; args: string; proconfig: string[] }>(
      `select prosecdef, pg_get_function_identity_arguments(oid) as args, proconfig from pg_proc
        where oid = 'public.set_club_theme(text, text)'::regprocedure`,
    );
    expect(r.rows).toEqual([{ prosecdef: true, args: "disc text, mark text", proconfig: ['search_path=""'] }]);
    // The body qualifies both parameters, as the AC asks and 0008's accept_answer() does.
    const body = await db.query<{ src: string }>(
      `select prosrc as src from pg_proc where oid = 'public.set_club_theme(text, text)'::regprocedure`,
    );
    // The UPDATE's own clause, not any mention: the qualified spelling also survives in the
    // contrast_ratio call and the error detail, so a bare /set_club_theme\.disc/ matched those
    // and let an unqualified UPDATE through (mutation M13 reddened 0 against a predicted 1).
    expect(body.rows[0].src).toMatch(/set brand_disc = set_club_theme\.disc,\s*brand_mark = set_club_theme\.mark/);
  });

  it("a non-admin is refused 42501 before the pair is even looked at, and the row is unchanged", async () => {
    // A pair that would pass — so the refusal below can only be the admin check.
    await expect(as(db, "authenticated", call("#000000", "#FFFFFF"), CREW)).rejects.toThrow(/not an admin/);
    // …and one that would fail: the same message, so a non-admin learns nothing about the rule.
    await expect(as(db, "authenticated", call("#FFFFFF", "#FFFFFE"), CREW)).rejects.toThrow(/not an admin/);
    expect((await stored()).rows).toEqual([{ brand_disc: HOOVER_SAILING_CLUB.disc, brand_mark: HOOVER_SAILING_CLUB.mark }]);
  });

  it("the admin is refused 'contrast' below 3.0, and the row is unchanged", async () => {
    await expect(as(db, "authenticated", call("#FFFFFF", "#FFFFFE"), ADMIN)).rejects.toThrow(/^contrast$|contrast/);
    await expect(as(db, "authenticated", call(...JUST_BELOW), ADMIN)).rejects.toThrow(/contrast/);
    await expect(as(db, "authenticated", call("#395FAC", "#395FAC"), ADMIN)).rejects.toThrow(/contrast/);
    expect((await stored()).rows).toEqual([{ brand_disc: HOOVER_SAILING_CLUB.disc, brand_mark: HOOVER_SAILING_CLUB.mark }]);
  });

  it("the admin is refused 'colour' for a non-colour or a NULL, and the row is unchanged", async () => {
    await expect(as(db, "authenticated", call("navy", "#FFFFFF"), ADMIN)).rejects.toThrow(/colour/);
    await expect(as(db, "authenticated", call("#000000", null), ADMIN)).rejects.toThrow(/colour/);
    await expect(as(db, "authenticated", call(null, null), ADMIN)).rejects.toThrow(/colour/);
    expect((await stored()).rows).toEqual([{ brand_disc: HOOVER_SAILING_CLUB.disc, brand_mark: HOOVER_SAILING_CLUB.mark }]);
  });

  it("the admin's passing pair is written — read back, not inferred — and exactly 3.0's neighbour passes", async () => {
    await as(db, "authenticated", call("#000000", "#FFFFFF"), ADMIN);
    expect((await stored()).rows).toEqual([{ brand_disc: "#000000", brand_mark: "#FFFFFF" }]);

    await as(db, "authenticated", call(...JUST_ABOVE), ADMIN);
    expect((await stored()).rows).toEqual([{ brand_disc: JUST_ABOVE[0], brand_mark: JUST_ABOVE[1] }]);

    // Back to the seed pair, so the fixture reads as it started for anything after this.
    await as(db, "authenticated", call(HOOVER_SAILING_CLUB.disc, HOOVER_SAILING_CLUB.mark), ADMIN);
    expect((await stored()).rows).toEqual([{ brand_disc: HOOVER_SAILING_CLUB.disc, brand_mark: HOOVER_SAILING_CLUB.mark }]);
  });

  it("no client role can update the pair directly — the function is the only writer", async () => {
    await expect(
      as(db, "authenticated", `update public.club set brand_disc = '#000000'`, ADMIN),
    ).rejects.toThrow(/permission denied for table club/);
    expect((await stored()).rows[0].brand_disc).toBe(HOOVER_SAILING_CLUB.disc);
  });
});

describe("0028 — grants", () => {
  it("anon may call neither; authenticated reaches set_club_theme and not contrast_ratio", async () => {
    await expect(as(db, "anon", call("#000000", "#FFFFFF"))).rejects.toThrow(
      /permission denied for function set_club_theme/,
    );
    await expect(as(db, "anon", `select public.contrast_ratio('#000000', '#FFFFFF')`)).rejects.toThrow(
      /permission denied for function contrast_ratio/,
    );
    // The screen computes the ratio in TypeScript; nothing a client does needs the SQL copy.
    await expect(
      as(db, "authenticated", `select public.contrast_ratio('#000000', '#FFFFFF')`, CREW),
    ).rejects.toThrow(/permission denied for function contrast_ratio/);
    // Positive control for the grant: authenticated reaches set_club_theme's body (refused there).
    await expect(as(db, "authenticated", call("#000000", "#FFFFFF"), CREW)).rejects.toThrow(/not an admin/);
  });
});
