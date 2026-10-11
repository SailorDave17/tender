import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigration, freshDb } from "./pglite";

/**
 * Story #267 — 0036 copies every member's attestation into `raw_app_meta_data`, the field only the
 * service role writes, so that `attestationOf` (src/auth/person.ts) can stop reading the field the
 * user writes.
 *
 * The fixture has to exist BEFORE 0036 runs, which is what `freshDb({ through })` is for: the
 * default harness applies every migration before any test can insert a row (the trap #64's AC 2
 * walked into). Three auth users, one per case the file has to tell apart:
 *
 *   ANN   a member: a person row, and the pre-#267 copy of her attestation in user_metadata.
 *         GoTrue's own keys sit in her app_metadata already, and must survive the merge.
 *   BEN   a member whose user_metadata carries NO attestation (a hand-edited user, say). His
 *         person row is the source, so he is backfilled all the same.
 *   EVE   no person row, and an attestation in user_metadata she wrote herself. Exactly the user
 *         #267 stops trusting — the file must leave her app_metadata alone.
 *
 * The person rows' `adult_attested_at` deliberately differs from the user_metadata copies, so an
 * assertion can tell which source the value was taken from.
 */

const ANN = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";

type Row = { id: string; app: Record<string, unknown> | null; meta: Record<string, unknown> | null };

async function users(db: PGlite): Promise<Map<string, Row>> {
  const r = await db.query<Row>(
    `select id::text as id, raw_app_meta_data as app, raw_user_meta_data as meta from auth.users order by id`,
  );
  return new Map(r.rows.map((row) => [row.id, row]));
}

describe("0036 backfills the attestation into app_metadata, from the person row, for members only", () => {
  let db: PGlite;
  let before: Map<string, Row>;

  beforeAll(async () => {
    db = await freshDb({ through: "0035" });
    await db.exec(`
      insert into auth.users (id, raw_app_meta_data, raw_user_meta_data) values
        ('${ANN}', '{"provider":"email","providers":["email"]}',
                   '{"adult_attested_at":"2026-01-01T00:00:00.000Z"}'),
        ('${BEN}', '{"provider":"google","providers":["google"]}', '{"full_name":"Ben Example"}'),
        ('${EVE}', '{"provider":"email","providers":["email"]}',
                   '{"adult_attested_at":"2026-01-01T00:00:00.000Z"}');
      insert into public.person (id, display_name, adult_attested_at) values
        ('${ANN}', 'Ann', '2026-08-22T12:00:00.123Z'),
        ('${BEN}', 'Ben', '2026-09-01T08:30:00Z');
    `);
    before = await users(db);
    await applyMigration(db, "0036");
  });

  afterAll(async () => {
    await db?.close();
  });

  it("before this test applies 0036, nobody's app_metadata carries the attestation", () => {
    // The precondition every assertion below rests on, read after the fixture and before the
    // apply. It is NOT a control for `through`, and nothing here can be: 0036 is data-only, so
    // run early over an empty auth.users it changes nothing, and the fixture written after it is
    // the same either way. *Measured* (#267's mutation pass): `through: "0036"` reddened 0 against
    // a predicted 1. A schema-changing migration's test can see `through`; this one cannot.
    for (const id of [ANN, BEN, EVE]) {
      expect(before.get(id)?.app, id).not.toHaveProperty("adult_attested_at");
    }
  });

  it("a member gets the PERSON ROW's attestation, in toISOString's format, and GoTrue's keys survive", async () => {
    const after = await users(db);
    // The person row's value, not the 2026-01-01 copy in user_metadata: the server's record.
    expect(after.get(ANN)?.app).toEqual({
      provider: "email",
      providers: ["email"],
      adult_attested_at: "2026-08-22T12:00:00.123Z",
    });
    // Byte-for-byte what `new Date(x).toISOString()` writes, so the gate's own writes and the
    // backfill cannot be told apart.
    const ann = String(after.get(ANN)?.app?.adult_attested_at);
    expect(new Date(ann).toISOString()).toBe(ann);
  });

  it("a member with no attestation anywhere in metadata is backfilled from the row all the same", async () => {
    const after = await users(db);
    expect(after.get(BEN)?.app).toEqual({
      provider: "google",
      providers: ["google"],
      adult_attested_at: "2026-09-01T08:30:00.000Z",
    });
  });

  it("an auth user with no person row is left alone, whatever her user_metadata claims", async () => {
    const after = await users(db);
    expect(after.get(EVE)?.app).toEqual(before.get(EVE)?.app);
    expect(after.get(EVE)?.app).not.toHaveProperty("adult_attested_at");
  });

  it("user_metadata is not touched — for anyone", async () => {
    const after = await users(db);
    for (const id of [ANN, BEN, EVE]) {
      expect(after.get(id)?.meta, id).toEqual(before.get(id)?.meta);
    }
  });

  it("is re-runnable: a second run changes nothing, and never overwrites a value already there", async () => {
    // A value the gate wrote after the first run (a different clock from the person row) must
    // survive the second: the file adds a key only where it is missing.
    await db.exec(
      `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"adult_attested_at":"2027-03-03T03:03:03.000Z"}'
        where id = '${BEN}'`,
    );
    const mid = await users(db);
    await applyMigration(db, "0036");
    expect(await users(db)).toEqual(mid);
    expect(mid.get(BEN)?.app?.adult_attested_at).toBe("2027-03-03T03:03:03.000Z");
  });
});
