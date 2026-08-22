import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`insert into public.club (name, brand_disc, brand_mark, invite_code)
                 values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');`);
});
afterAll(async () => {
  await db.close();
});

describe("club (0001)", () => {
  it("has row level security enabled", async () => {
    const r = await db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'public.club'::regclass`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it("is readable by a signed-in person", async () => {
    const r = await as(db, "authenticated", `select name from public.club`);
    expect(r.rows).toEqual([{ name: "Hoover Sailing Club" }]);
  });

  it("is not readable anonymously", async () => {
    await expect(as(db, "anon", `select name from public.club`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("cannot be written by a signed-in person (no policy, no grant)", async () => {
    await expect(
      as(db, "authenticated", `update public.club set brand_disc = '#000000'`),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a theme value that is not a hex colour", async () => {
    await expect(
      db.exec(`insert into public.club (name, brand_disc, brand_mark, invite_code)
               values ('x', 'navy', '#FCCF0B', 'c')`),
    ).rejects.toThrow(/check constraint/);
  });
});
