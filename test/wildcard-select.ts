/**
 * Finds supabase-js reads of a table that project every column — `.from("club").select("*")`,
 * `.select()` with no argument, or `select("*, …")` — which 0002 makes fail at runtime, because
 * a column withheld from the select grant refuses the wildcard outright rather than omitting the
 * column (cairn: supabase-rls-column-grants-2026-08-06).
 *
 * A pure function over source text, so the test can prove it detects the thing on a synthetic
 * fixture: today `src/` holds no supabase client at all, and a scan of an empty corpus passes for
 * the wrong reason (cairn: a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

export type WildcardSelect = { line: number; text: string };

/** Strip // and /* comments so a comment that quotes the pattern is not a finding. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

export function findWildcardSelects(source: string, table: string): WildcardSelect[] {
  const code = stripComments(source);
  const from = new RegExp(
    String.raw`\.from\(\s*["'\x60]${table}["'\x60]\s*\)([\s\S]{0,200}?)\.select\(\s*(["'\x60])?([^)]*?)\2?\s*\)`,
    "g",
  );
  const found: WildcardSelect[] = [];
  for (const m of code.matchAll(from)) {
    const between = m[1];
    // Another .from() in between means the .select() belongs to a different chain.
    if (/\.from\(/.test(between)) continue;
    const projection = (m[3] ?? "").trim();
    const wildcard = projection === "" || /(^|,)\s*\*\s*(,|$)/.test(projection);
    if (!wildcard) continue;
    const line = code.slice(0, m.index).split("\n").length;
    found.push({ line, text: source.split("\n")[line - 1].trim() });
  }
  return found;
}
