import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "./pglite";

/**
 * Two facts about the migration set that are otherwise held by hand.
 *
 * 1. The migrations record nothing from which a person's years can be inferred (story #14 AC 1).
 *    Read as files rather than through git so the check is the same under CI and locally.
 * 2. `scripts/check-live.mjs`'s EXPECTED_TABLES is the set of tables the migrations create — a
 *    copy of a fact the migrations already hold, which is the class that drifts (cairn:
 *    a-computable-claim-does-not-belong-in-prose-2026-08-07). The script cannot be imported (it
 *    probes and exits at module load), so the literal is read out of its source.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

describe("supabase/migrations — no way to infer how old a person is", () => {
  it("mentions none of the usual spellings", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(join(MIGRATIONS, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/date_of_birth|birth|\bage\b/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("check:live expects exactly the tables the migrations create", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("EXPECTED_TABLES in scripts/check-live.mjs equals public's tables in the harness", async () => {
    const src = await readFile(join(process.cwd(), "scripts", "check-live.mjs"), "utf8");
    const m = /const EXPECTED_TABLES = \[([^\]]*)\]/.exec(src);
    expect(m, "EXPECTED_TABLES literal not found in scripts/check-live.mjs").not.toBeNull();
    const expected = [...m![1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();

    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const created = r.rows.map((x) => x.tablename);
    expect(created.length).toBeGreaterThan(0);
    expect(expected).toEqual(created);
  });
});
