import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0022 — `members_among()`, the case-insensitive member lookup the invite send asks (story #31
 * AC 3).
 *
 * Three claims, each proven in the direction that can fail:
 *
 *   1. It matches a STORED mixed-case address against a lowercase paste. This is the whole reason
 *      the function exists: PostgREST's `in` compares the lowercased list against the stored
 *      spelling and silently misses such a row, so the JavaScript that preceded this had to read
 *      every contact row to be correct.
 *   2. It returns ONLY the addresses it was asked about — it is an answer, not a table, and the
 *      club cannot be enumerated through it. That is what makes it narrower than the read it
 *      replaced, and it is the claim a future "just add a filter" change would break.
 *   3. `service_role` may execute it and the client roles may NOT, by name. The hosted project
 *      grants `anon` execute on every new function directly while the local image does not
 *      (cairn: postgrest-probing-a-live-project §4), so the revoke is load-bearing and the negative
 *      arm below is what proves the file did it rather than an absent default.
 *
 * The negative arm for the GRANT boots `through: "0021"` — the world before this file — where the
 * function does not exist at all, so the positive arm's success is 0022's doing.
 */

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const FIXTURE = `
  insert into public.club (name, brand_disc, brand_mark, invite_code)
    values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
  insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
  insert into public.person (id, display_name, adult_attested_at, rating) values
    ('${A}', 'Mixed Case', now(), 2),
    ('${B}', 'Lower Case', now(), 2),
    ('${C}', 'Not Pasted', now(), 2);
  -- The first address is stored MIXED CASE on purpose: it is the row a naive filter misses.
  insert into public.person_contact (person_id, email) values
    ('${A}', 'Dave.Smith@Example.org'),
    ('${B}', 'sue@example.org'),
    ('${C}', 'nobody-asked@example.org');
`;

let db: PGlite;
let before: PGlite;
beforeAll(async () => {
  // Sequential, not Promise.all — two concurrent boots in one file push a saturated machine past
  // harness-budget.test.ts's boot budget (measured on #24).
  db = await freshDb();
  await db.exec(FIXTURE);
  before = await freshDb({ through: "0021" });
}, 120_000);

afterAll(async () => {
  await db?.close();
  await before?.close();
});

/** `members_among` as service_role, returning the matched addresses sorted. */
async function membersAmong(on: PGlite, emails: string[]): Promise<string[]> {
  const list = `array[${emails.map((e) => `'${e}'`).join(",")}]::text[]`;
  const rows = await as(on, "service_role", `select * from public.members_among(${list}) order by 1`);
  return rows.rows.map((r) => String(Object.values(r as object)[0]));
}

describe("members_among() finds the members and nobody else (AC 3)", () => {
  it("matches a stored MIXED-CASE address against a lowercase paste", async () => {
    // The case a PostgREST `in` filter silently misses, which is why this is a function.
    expect(await membersAmong(db, ["dave.smith@example.org"])).toEqual(["dave.smith@example.org"]);
  });

  it("matches in the other direction too — a mixed-case paste against a lowercase row", async () => {
    expect(await membersAmong(db, ["SUE@EXAMPLE.ORG"])).toEqual(["sue@example.org"]);
  });

  it("returns only what it was asked about, never the rest of the club", async () => {
    // `nobody-asked@example.org` is a member and is NOT in the answer: the function cannot be
    // used to enumerate the club, which is the property that makes it narrower than reading
    // person_contact.
    const answer = await membersAmong(db, ["dave.smith@example.org", "stranger@example.org"]);
    expect(answer).toEqual(["dave.smith@example.org"]);
    expect(answer).not.toContain("nobody-asked@example.org");
  });

  it("answers nothing for a list of non-members — and the positive control sits beside it", async () => {
    expect(await membersAmong(db, ["stranger@example.org", "other@example.org"])).toEqual([]);
    // The same call shape with a real member, so the empty read above means REFUSED-BY-ABSENCE
    // rather than the query being wrong.
    expect(await membersAmong(db, ["sue@example.org"])).toEqual(["sue@example.org"]);
  });

  it("answers nothing for an empty array without erroring", async () => {
    expect(await membersAmong(db, [])).toEqual([]);
  });

  it("de-duplicates a repeated address", async () => {
    expect(await membersAmong(db, ["sue@example.org", "SUE@example.org"])).toEqual(["sue@example.org"]);
  });
});

describe("who may execute it (AC 3's grant)", () => {
  it("service_role may — proven by every case above, and named here", async () => {
    const rows = await as(db, "service_role", "select public.members_among(array['sue@example.org']::text[])");
    expect(rows.rows).toHaveLength(1);
  });

  for (const role of ["anon", "authenticated"] as const) {
    it(`${role} may not`, async () => {
      await expect(
        as(db, role, "select public.members_among(array['sue@example.org']::text[])"),
      ).rejects.toThrow(/permission denied/i);
    });
  }

  it("through 0021 the function does not exist — so 0022 is what created it", async () => {
    await expect(
      as(before, "service_role", "select public.members_among(array['sue@example.org']::text[])"),
    ).rejects.toThrow(/does not exist/i);
  });

  it("the lower(email) index exists, which is what makes the lookup a lookup", async () => {
    const rows = await db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'person_contact'",
    );
    expect(rows.rows.map((r) => r.indexname)).toContain("person_contact_email_lower");
  });
});
