import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyMigration, as, freshDb } from "./pglite";

/**
 * 0029 — a deletion takes the person's device push addresses out of notification_log (story #197).
 *
 * A push row's provider_id is the device's push endpoint (src/notify/*: `providerId:
 * target.endpoint`); an email row's is Resend's message id. 0027's delete_person() blanked
 * to_email and left provider_id, so a deleted person's push rows kept the URL of their device.
 *
 * AC 2's three sides, on the full schema: after a deletion the person's push rows keep kind and
 * sent_at and lose provider_id; their email rows keep provider_id; another person's push rows are
 * untouched. Rows are named by a fixed id, since person_id is null on the leaver's rows afterwards
 * and would no longer tell them apart from anyone else's.
 *
 * AC 3's backfill, on a schema built through 0028: a person deleted by 0027's function keeps the
 * endpoint (the defect, measured rather than assumed), and applying 0029 clears it without
 * touching the email row beside it or a living person's push row.
 *
 * The two describes boot their databases one after the other, never in parallel (the overlay's
 * two-pglite rule, #24).
 */

const LEAVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const LEE_PUSH = "f1000000-0000-4000-8000-000000000001";
const LEE_PUSH_GONE = "f1000000-0000-4000-8000-000000000002";
const LEE_EMAIL = "f1000000-0000-4000-8000-000000000003";
const OTTO_PUSH = "f1000000-0000-4000-8000-000000000004";
const OTTO_EMAIL = "f1000000-0000-4000-8000-000000000005";

const SENT_1 = "2026-09-01T12:00:00+00:00";
const SENT_2 = "2026-09-02T12:00:00+00:00";

type LogRow = {
  id: string;
  kind: string;
  channel: string;
  person_id: string | null;
  to_email: string | null;
  sent_at: string;
  provider_id: string | null;
};

const readLog = async (db: PGlite): Promise<LogRow[]> =>
  (
    await db.query<LogRow>(
      `select id, kind, channel, person_id, to_email,
              to_char(sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as sent_at, provider_id
         from public.notification_log order by id`,
    )
  ).rows;

const seed = (db: PGlite) =>
  db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${LEAVER}'), ('${OTHER}');
    insert into public.person (id, display_name, adult_attested_at, rating) values
      ('${LEAVER}', 'Lee', now(), 3),
      ('${OTHER}', 'Otto', now(), 2);
    insert into public.person_contact (person_id, email) values
      ('${LEAVER}', 'lee@hsc-crew.org'),
      ('${OTHER}', 'otto@hsc-crew.org');
    insert into public.push_subscription (person_id, endpoint, p256dh, auth) values
      ('${LEAVER}', 'https://push.example/lee/1', 'k', 'a'),
      ('${OTHER}', 'https://push.example/otto/1', 'k', 'a');
    insert into public.notification_log (id, kind, channel, person_id, to_email, sent_at, provider_id, error) values
      ('${LEE_PUSH}', 'rung_push', 'push', '${LEAVER}', null, '${SENT_1}', 'https://push.example/lee/1', null),
      ('${LEE_PUSH_GONE}', 'rung_push_gone', 'push', '${LEAVER}', null, '${SENT_2}', 'https://push.example/lee/2', 'Received unexpected response code'),
      ('${LEE_EMAIL}', 'rung_email', 'email', '${LEAVER}', 'lee@hsc-crew.org', '${SENT_1}', 're_lee_1', null),
      ('${OTTO_PUSH}', 'rung_push', 'push', '${OTHER}', null, '${SENT_1}', 'https://push.example/otto/1', null),
      ('${OTTO_EMAIL}', 'rung_email', 'email', '${OTHER}', 'otto@hsc-crew.org', '${SENT_1}', 're_otto_1', null);
  `);

/** Otto's two rows, which no deletion and no backfill may touch — the same in every reading. */
const OTTO_ROWS: LogRow[] = [
  { id: OTTO_PUSH, kind: "rung_push", channel: "push", person_id: OTHER, to_email: null, sent_at: "2026-09-01T12:00:00", provider_id: "https://push.example/otto/1" },
  { id: OTTO_EMAIL, kind: "rung_email", channel: "email", person_id: OTHER, to_email: "otto@hsc-crew.org", sent_at: "2026-09-01T12:00:00", provider_id: "re_otto_1" },
];

describe("0029 — delete_person() takes the person's push endpoints with them (AC 2)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await seed(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("before the deletion, both of Lee's push rows carry an endpoint — the fixture has something to lose", async () => {
    const lee = (await readLog(db)).filter((r) => r.person_id === LEAVER && r.channel === "push");
    expect(lee.map((r) => r.provider_id)).toEqual(["https://push.example/lee/1", "https://push.example/lee/2"]);
  });

  it("after Lee deletes themself: their push rows keep kind and sent_at and lose the endpoint; their email row keeps Resend's id; Otto's rows are untouched", async () => {
    await as(db, "authenticated", `select public.delete_person('${LEAVER}')`, LEAVER);

    expect(await readLog(db)).toEqual([
      { id: LEE_PUSH, kind: "rung_push", channel: "push", person_id: null, to_email: null, sent_at: "2026-09-01T12:00:00", provider_id: null },
      { id: LEE_PUSH_GONE, kind: "rung_push_gone", channel: "push", person_id: null, to_email: null, sent_at: "2026-09-02T12:00:00", provider_id: null },
      // 0027's half, still in force: the address goes. 0029 keeps the message id.
      { id: LEE_EMAIL, kind: "rung_email", channel: "email", person_id: null, to_email: null, sent_at: "2026-09-01T12:00:00", provider_id: "re_lee_1" },
      ...OTTO_ROWS,
    ]);
    // The deletion itself happened — the rows above are a deleted person's, not a refused call's.
    expect((await db.query(`select 1 from public.person where id = '${LEAVER}'`)).rows).toHaveLength(0);
  });

  it("create or replace kept 0027's grants: anon may not call delete_person(), authenticated may", async () => {
    const grants = await db.query<{ anon: boolean; authenticated: boolean }>(
      `select has_function_privilege('anon', 'public.delete_person(uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.delete_person(uuid)', 'execute') as authenticated`,
    );
    expect(grants.rows).toEqual([{ anon: false, authenticated: true }]);
  });
});

describe("0029 — the backfill clears endpoints left by deletions made before it (AC 3)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb({ through: "0028" });
    await seed(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("through 0028, a deletion by 0027's delete_person() leaves Lee's endpoints in the log — the defect this file exists for", async () => {
    // `through` is inclusive: 0028's own function is here, so the schema is the one 0029 meets.
    const theme = await db.query(`select 1 from pg_proc where proname = 'set_club_theme'`);
    expect(theme.rows, "0028's set_club_theme should be present — through is inclusive").toHaveLength(1);

    await as(db, "authenticated", `select public.delete_person('${LEAVER}')`, LEAVER);

    const lee = (await readLog(db)).filter((r) => r.id === LEE_PUSH || r.id === LEE_PUSH_GONE);
    expect(lee.map((r) => [r.person_id, r.provider_id])).toEqual([
      [null, "https://push.example/lee/1"],
      [null, "https://push.example/lee/2"],
    ]);
  });

  it("applying 0029 nulls those endpoints, keeps the email row's id and Otto's rows, and a second run changes nothing", async () => {
    await applyMigration(db, "0029");
    const after: LogRow[] = [
      { id: LEE_PUSH, kind: "rung_push", channel: "push", person_id: null, to_email: null, sent_at: "2026-09-01T12:00:00", provider_id: null },
      { id: LEE_PUSH_GONE, kind: "rung_push_gone", channel: "push", person_id: null, to_email: null, sent_at: "2026-09-02T12:00:00", provider_id: null },
      { id: LEE_EMAIL, kind: "rung_email", channel: "email", person_id: null, to_email: null, sent_at: "2026-09-01T12:00:00", provider_id: "re_lee_1" },
      ...OTTO_ROWS,
    ];
    expect(await readLog(db)).toEqual(after);

    await applyMigration(db, "0029");
    expect(await readLog(db)).toEqual(after);
  });
});
