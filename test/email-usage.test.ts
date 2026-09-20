import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { EMAIL_ATTEMPT_KINDS } from "@/notify/kinds";
import { KIND_RUNG_EMAIL, KIND_RUNG_EMAIL_NO_ADDRESS, KIND_RUNG_EMAIL_SKIPPED_CAP } from "@/notify/rung";
import { as, freshDb } from "./pglite";

/**
 * 0026 — email_usage(). Story #39 AC 2: the counter reads the day's email attempts from
 * notification_log, and only those.
 *
 * ## Why every instant here is a literal
 *
 * The function takes its two boundaries as arguments rather than reading `now()` (0026's header:
 * /admin decides its whole page at one instant, and a second clock in the database could put the
 * day boundary on the other side of UTC midnight from the one the page printed). The gift to this
 * file is that nothing here is relative to the wall clock, so there is no flaky second either side
 * of midnight and no fixture that has to be rebuilt relative to today — unlike
 * `test/tick.test.ts`, whose subject genuinely reads `now()`.
 *
 * ## The kinds come from the application's own list
 *
 * `EMAIL_ATTEMPT_KINDS` is imported rather than restated, which is the whole reason 0026 takes the
 * kinds as an argument: the list lives in `src/notify/kinds.ts`, `test/kinds.test.ts` holds it to
 * every sender's constants, and this file holds the SQL to the same list. A literal here would be
 * the fourth copy and the one nothing compares.
 *
 * ## What the AC asked for and what this counts (owner decision 2026-09-20)
 *
 * AC 1 was filed saying "channel = email rows". Counting those would include
 * `rung_email_skipped_cap` and `rung_email_no_address` — rows logged for sends that never reached
 * Resend — so the screen would read higher than the cap the senders enforce, and would do it on
 * exactly the day the cap started biting. The owner chose attempts. The two cases at the bottom
 * are what hold that: remove the kind filter from 0026 and they redden.
 */

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CREW = "22222222-2222-4222-8222-222222222222";

/** The instants the page would hand in, for a render at midday UTC on 20 September 2026. */
const DAY_START = "2026-09-20T00:00:00Z";
const MONTH_START = "2026-09-01T00:00:00Z";
const TODAY = "2026-09-20T10:00:00Z";
const YESTERDAY = "2026-09-19T10:00:00Z";
const LAST_MONTH = "2026-08-15T10:00:00Z";

/** `array['rung_email', …]` from the application's list — never a literal. */
const KINDS = `array[${EMAIL_ATTEMPT_KINDS.map((k) => `'${k}'`).join(", ")}]::text[]`;

const usage = (kinds = KINDS) =>
  `select day_count, month_count from public.email_usage(${kinds}, '${DAY_START}'::timestamptz, '${MONTH_START}'::timestamptz)`;

type Counts = { day_count: number; month_count: number };

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'JOINHSC1');
    insert into auth.users (id) values ('${ADMIN}'), ('${CREW}');
    insert into public.person (id, display_name, adult_attested_at, is_admin) values
      ('${ADMIN}', 'Ada', now(), true),
      ('${CREW}', 'Cy', now(), false);
  `);

  // AC 2's fixture, to the letter: 3 email and 2 push rows today, 4 email rows yesterday. Plus a
  // row last month, so the monthly figure has a boundary of its own to be wrong about, and two
  // non-attempt rows today, which are the owner's decision under test.
  await db.exec(`
    insert into public.notification_log (kind, channel, sent_at) values
      ('${KIND_RUNG_EMAIL}', 'email', '${TODAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${TODAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${TODAY}'),
      ('rung_push',          'push',  '${TODAY}'),
      ('rung_push',          'push',  '${TODAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${YESTERDAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${YESTERDAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${YESTERDAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${YESTERDAY}'),
      ('${KIND_RUNG_EMAIL}', 'email', '${LAST_MONTH}'),
      ('${KIND_RUNG_EMAIL_SKIPPED_CAP}', 'email', '${TODAY}'),
      ('${KIND_RUNG_EMAIL_NO_ADDRESS}',  'email', '${TODAY}');
  `);
});
afterAll(async () => {
  await db.close();
});

describe("email_usage (0026) — shape and grants", () => {
  it("is a stable definer with search_path pinned and three input arguments", async () => {
    const r = await db.query<{ prosecdef: boolean; proconfig: string[]; provolatile: string; args: string }>(
      `select prosecdef, proconfig, provolatile, pg_get_function_identity_arguments(oid) as args
         from pg_proc where oid = 'public.email_usage(text[], timestamptz, timestamptz)'::regprocedure`,
    );
    expect(r.rows).toEqual([
      {
        prosecdef: true,
        proconfig: ['search_path=""'],
        provolatile: "s",
        args: "p_kinds text[], p_day_start timestamp with time zone, p_month_start timestamp with time zone",
      },
    ]);
  });

  it("anon may not call it; authenticated reaches the body and is refused there when not an admin", async () => {
    // Load-bearing, but not in the half you would guess. *Measured by mutation 2026-09-20*:
    // dropping `, anon` from 0026's revoke leaves this GREEN — 0015's default-privileges line
    // already removed the platform's by-name grant for every function created after it — while
    // dropping the whole revoke reddens this and `test/anon-grants.test.ts`'s schema-wide sweep,
    // because Postgres's built-in EXECUTE to PUBLIC is what is left and what `from public` takes.
    await expect(as(db, "anon", usage())).rejects.toThrow(/permission denied for function email_usage/);
    // Positive control on the same mechanism: the grant admits a signed-in person, and it is the
    // body's own check that refuses them — a different refusal, with a different message.
    await expect(as(db, "authenticated", usage(), CREW)).rejects.toThrow(/not an admin/);
  });

  it("the admin cannot read notification_log itself — a count is all the definer hands back", async () => {
    // 0010's revoke plus RLS with no policy. This is why the function exists at all: without it
    // the screen would need a select on a table that names who was emailed at what address.
    await expect(
      as(db, "authenticated", `select count(*) from public.notification_log`, ADMIN),
    ).rejects.toThrow(/permission denied for table notification_log/);
    // …and the count still comes back through the function for the same person.
    const r = await as(db, "authenticated", usage(), ADMIN);
    expect((r.rows as Counts[])[0].day_count).toBe(3);
  });
});

describe("email_usage (0026) — what it counts", () => {
  it("AC 2: 3 email and 2 push today, 4 email yesterday — the day reads 3", async () => {
    const r = await as(db, "authenticated", usage(), ADMIN);
    expect((r.rows as Counts[])[0].day_count).toBe(3);
  });

  it("the month spans the day and the days before it, and stops at the month boundary", async () => {
    // 3 today + 4 yesterday = 7. The row at 2026-08-15 is in neither window; if `>= least(...)`
    // were dropped for an unbounded scan it would read 8.
    const r = await as(db, "authenticated", usage(), ADMIN);
    expect((r.rows as Counts[])[0].month_count).toBe(7);
  });

  it("push rows never count, whatever kind they carry", async () => {
    // The channel filter, on its own: ask for the push kind and the answer is zero, though two
    // such rows sit inside the day.
    const r = await as(db, "authenticated", usage(`array['rung_push']::text[]`), ADMIN);
    expect(r.rows as Counts[]).toEqual([{ day_count: 0, month_count: 0 }]);
  });

  it("skipped-cap and no-address rows are email rows and are NOT attempts", async () => {
    // Both sit in the day on channel 'email'. The owner's decision is that they do not count —
    // so a count over `channel = 'email'` alone would read 5 today rather than 3, and would read
    // it highest on the day the cap was already biting.
    const both = `array['${KIND_RUNG_EMAIL_SKIPPED_CAP}', '${KIND_RUNG_EMAIL_NO_ADDRESS}']::text[]`;
    const r = await as(db, "authenticated", usage(both), ADMIN);
    expect((r.rows as Counts[])[0].day_count).toBe(2); // they exist…
    expect(EMAIL_ATTEMPT_KINDS).not.toContain(KIND_RUNG_EMAIL_SKIPPED_CAP); // …and the app's list omits them
    expect(EMAIL_ATTEMPT_KINDS).not.toContain(KIND_RUNG_EMAIL_NO_ADDRESS);
  });

  it("an empty kind list counts nothing, so a caller that sends no kinds cannot read a whole-table count", async () => {
    const r = await as(db, "authenticated", usage(`array[]::text[]`), ADMIN);
    expect(r.rows as Counts[]).toEqual([{ day_count: 0, month_count: 0 }]);
  });

  it("returns exactly one row, so the caller's [0] is never undefined on a successful call", async () => {
    // `loadEmailUsage` treats a missing row as a failed read rather than as zero. That arm should
    // be unreachable, and this is what says so.
    const r = await as(db, "authenticated", usage(), ADMIN);
    expect(r.rows).toHaveLength(1);
  });
});
