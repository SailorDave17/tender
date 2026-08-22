import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findWildcardSelects } from "./wildcard-select";

/**
 * 0002 withholds invite_code from the client's select grant on club, so any
 * `.from("club").select("*")` in the app fails at runtime with 42501 — loudly, but only when that
 * line runs. This finds it at test time instead.
 */

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p);
  }
  return out;
}

describe("the detector itself — proven on a fixture, since src/ may hold no client at all", () => {
  it("finds select('*'), a bare select(), a backtick form and a '*, …' embed", () => {
    const fixture = [
      `const a = await supabase.from("club").select("*");`,
      `const b = await supabase.from('club').select();`,
      "const c = await supabase.from(`club`)\n  .select(`*`)\n  .single();",
      `const d = await supabase.from("club").select("*, person(*)");`,
    ].join("\n");
    expect(findWildcardSelects(fixture, "club").map((f) => f.line)).toEqual([1, 2, 3, 6]);
  });

  it("ignores an explicit column list, another table, a comment, and a chain broken by a second from()", () => {
    const fixture = [
      `const a = await supabase.from("club").select("id, name, brand_disc, brand_mark");`,
      `const b = await supabase.from("person").select("*");`,
      `// supabase.from("club").select("*") — quoted in a comment`,
      `/* supabase.from("club").select("*") */`,
      `const c = supabase.from("club"); const d = supabase.from("person").select("*");`,
    ].join("\n");
    expect(findWildcardSelects(fixture, "club")).toEqual([]);
  });
});

describe("src/ (AC 5)", () => {
  it("contains no wildcard select on club", async () => {
    const files = await sourceFiles(join(process.cwd(), "src"));
    expect(files.length).toBeGreaterThan(0); // the corpus exists; an empty scan is not a pass
    const hits: string[] = [];
    for (const f of files) {
      for (const hit of findWildcardSelects(await readFile(f, "utf8"), "club")) {
        hits.push(`${f}:${hit.line}: ${hit.text}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
