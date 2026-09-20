import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Story #40 AC 2: an upload alone makes zero inserts. The live probe measures that on the
 * running stack (the row count before and after an upload); this holds the structural half —
 * the upload action's module imports no database client, so it cannot insert whatever a later
 * edit does to its body. The publish action lives in a separate file for exactly this reason.
 *
 * The hunt is grep-shaped, so it is proven on a fixture first (cairn:
 * a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const UPLOAD = join(process.cwd(), "src", "app", "admin", "dates", "import", "upload.ts");

/** Any import that could reach Supabase: the server helpers, the admin client, the SDKs. */
const DB_IMPORT = /from\s+["'](@\/lib\/supabase\/[^"']*|@supabase\/[^"']*)["']/;

describe("the .ics upload action cannot reach the database", () => {
  it("the hunt matches an import of the server client, on a fixture", () => {
    expect(DB_IMPORT.test('import { supabaseServer } from "@/lib/supabase/server";')).toBe(true);
    expect(DB_IMPORT.test('import { supabaseAdmin } from "@/lib/supabase/admin";')).toBe(true);
    expect(DB_IMPORT.test('import { createClient } from "@supabase/supabase-js";')).toBe(true);
    expect(DB_IMPORT.test('import { parseRaceIcs } from "@/dates/ics-import";')).toBe(false);
  });

  it("upload.ts parses and imports no Supabase module", async () => {
    const src = await readFile(UPLOAD, "utf8");
    expect(src).toMatch(/parseRaceIcs/);
    expect(src).not.toMatch(DB_IMPORT);
  });
});
