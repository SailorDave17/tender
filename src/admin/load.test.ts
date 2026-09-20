import { describe, expect, it } from "vitest";
import { loadSeasonData } from "./load";

/**
 * Story #38 — what `loadSeasonData` ASKS FOR, as opposed to what the database answers.
 *
 * This file exists because of a measured hole, and the hole is worth recording because it is the
 * shape a pglite test cannot see. `test/admin-season.test.ts` proves an unpublished date's rows
 * are refused, but it does so by running its own SQL string (`… where published`) — so it tests
 * Postgres, not this module. *Measured*: deleting `.eq("published", true)` from the loader
 * reddened **zero** tests against a predicted 1, because every instrument in the repo was either
 * a pure function that never sees the query or a SQL string that re-spells the filter rather than
 * invoking it.
 *
 * The consequence of that hole shipping would be quiet: an unpublished race date would appear on
 * /admin with zero posts and zero matches, because `post_read_published` still hides its posts
 * from everyone. It would read as "nobody posted for this date" — a true-looking sentence about a
 * date that is not on the board yet.
 *
 * So the subject here is the call itself. The fake records the table, the columns and the filters
 * each read builds, which is the only artefact that distinguishes a loader that filters from one
 * that does not.
 */

type Recorded = { table: string; columns: string; filters: [string, unknown][]; ordered: string[] };

/**
 * A stand-in for the PostgREST builder: every method returns the same thenable, so a chain of any
 * length records itself and resolves to `{ data: [] }`. It deliberately implements only the four
 * methods this loader uses — a fifth would throw, which is what makes it a test of the call.
 */
function fakeClient(): { client: Parameters<typeof loadSeasonData>[0]; reads: Recorded[] } {
  const reads: Recorded[] = [];
  const from = (table: string) => {
    const rec: Recorded = { table, columns: "", filters: [], ordered: [] };
    reads.push(rec);
    const builder = {
      select(columns: string) {
        rec.columns = columns;
        return builder;
      },
      eq(column: string, value: unknown) {
        rec.filters.push([column, value]);
        return builder;
      },
      order(column: string) {
        rec.ordered.push(column);
        return builder;
      },
      then(resolve: (v: { data: never[] }) => unknown) {
        return Promise.resolve(resolve({ data: [] }));
      },
    };
    return builder;
  };
  return { client: { from } as unknown as Parameters<typeof loadSeasonData>[0], reads };
}

async function readsOf(): Promise<Map<string, Recorded>> {
  const { client, reads } = fakeClient();
  await loadSeasonData(client);
  return new Map(reads.map((r) => [r.table, r]));
}

describe("loadSeasonData — the query it builds", () => {
  it("asks race_date for PUBLISHED rows only", async () => {
    // The mutation this file was written for: dropping this filter reddens nothing else.
    const reads = await readsOf();
    expect(reads.get("race_date")?.filters).toEqual([["published", true]]);
  });

  it("orders race dates by start, so the season reads in order", async () => {
    expect((await readsOf()).get("race_date")?.ordered).toEqual(["starts_at"]);
  });

  it("reads all five tables the screens need", async () => {
    const reads = await readsOf();
    expect([...reads.keys()].sort()).toEqual(["boat", "match", "person", "post", "race_date"]);
  });

  it("never selects a column withheld from authenticated", async () => {
    // `select('*')` would 500 on a correct schema: match.reminded_at is service_role only (0021)
    // and person.adult_attested_at is granted to nobody (0002). Naming columns is load-bearing,
    // so this asserts the absence of the star as well as of the two columns by name.
    const reads = await readsOf();
    for (const [table, r] of reads) {
      expect(r.columns, `${table} selects *`).not.toContain("*");
    }
    expect(reads.get("match")?.columns).not.toContain("reminded_at");
    expect(reads.get("person")?.columns).not.toContain("adult_attested_at");
  });

  it("reads the stored rung, which is what the detail screen prints as the final rung", async () => {
    expect((await readsOf()).get("post")?.columns).toContain("current_rung");
  });

  it("does not filter post or match — the screens aggregate the whole season", async () => {
    const reads = await readsOf();
    expect(reads.get("post")?.filters).toEqual([]);
    expect(reads.get("match")?.filters).toEqual([]);
  });
});
