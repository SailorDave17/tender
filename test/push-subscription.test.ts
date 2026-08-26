import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, freshDb } from "./pglite";

/**
 * 0013 — push_subscription, suggestion.pushed_at and push_install_status() (story #29 AC 1, 6).
 *
 * A subscription endpoint is a CAPABILITY: whoever holds it can push to that phone until the
 * browser revokes it. So the cases that matter most here are the refusals — that a signed-in
 * member cannot read, delete or write anyone else's row, and that the keys are withheld from
 * every client role including the row's own owner.
 *
 * Every deny is against `authenticated`, with service_role or the owner beside it as the positive
 * control on the same statement, so a `0`/`[]` reading means *refused* rather than *query wrong*.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANA = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BO = "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BOAT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const POST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const endpointOf = (who: string, n = 1) => `https://push.example/${who}/${n}`;

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into public.club (name, brand_disc, brand_mark, invite_code)
      values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'rotate-me');
    insert into auth.users (id) values ('${ADMIN}'), ('${ANA}'), ('${BO}');
    insert into public.person (id, display_name, adult_attested_at, rating, is_admin) values
      ('${ADMIN}', 'Sam Skipper', now(), 4, true),
      ('${ANA}',   'Ana Crew',    now(), 3, false),
      ('${BO}',    'Bo Crew',     now(), 2, false);
    insert into public.race_date (id, starts_at, title, published)
      values ('${DATE}', now() + interval '7 days', 'Spring Series 3', true);
    insert into public.boat (id, owner_id, name, class, default_minimum)
      values ('${BOAT}', '${ADMIN}', 'Blue Moon', 'Thistle', 2);
    insert into public.post (id, boat_id, race_date_id, minimum) values ('${POST}', '${BOAT}', '${DATE}', 2);
  `);
});

afterAll(async () => {
  await db.close();
});

describe("push_subscription — a member's own devices, and nobody else's (AC 1)", () => {
  it("a signed-in member stores their own subscription, and a second device adds a second row", async () => {
    for (const n of [1, 2]) {
      await as(
        db,
        "authenticated",
        `insert into public.push_subscription (person_id, endpoint, p256dh, auth)
         values ('${ANA}', '${endpointOf("ana", n)}', 'BNc...', 'k3y')`,
        ANA,
      );
    }
    const mine = await as(db, "authenticated", `select id from public.push_subscription`, ANA);
    expect(mine.rows).toHaveLength(2);
  });

  it("refuses an insert naming somebody else — the policy, not the action, decides", async () => {
    // The Server Action already takes person_id from the session. This is the database saying so
    // a second time, which is what makes a crafted POST harmless.
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.push_subscription (person_id, endpoint, p256dh, auth)
         values ('${BO}', '${endpointOf("stolen")}', 'BNc...', 'k3y')`,
        ANA,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("one endpoint belongs to one row: the first owner keeps it", async () => {
    await expect(
      as(
        db,
        "authenticated",
        `insert into public.push_subscription (person_id, endpoint, p256dh, auth)
         values ('${BO}', '${endpointOf("ana", 1)}', 'BNc...', 'k3y')`,
        BO,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("another member's rows are invisible — and the positive control is that their own are not", async () => {
    await as(
      db,
      "authenticated",
      `insert into public.push_subscription (person_id, endpoint, p256dh, auth)
       values ('${BO}', '${endpointOf("bo")}', 'BNc...', 'k3y')`,
      BO,
    );
    // Bo reads one row: their own. Ana's two are not among them.
    const bo = await as(db, "authenticated", `select id from public.push_subscription`, BO);
    expect(bo.rows).toHaveLength(1);
    const ana = await as(db, "authenticated", `select id from public.push_subscription`, ANA);
    expect(ana.rows).toHaveLength(2);
    // ...and asking for the other person's rows by id returns nothing rather than erroring,
    // which is RLS filtering rather than a grant refusing.
    const crafted = await as(db, "authenticated", `select id from public.push_subscription where person_id = '${ANA}'`, BO);
    expect(crafted.rows).toEqual([]);
  });

  it("the KEYS are withheld from every client role, the row's own owner included", async () => {
    // The crypto material: nothing in the browser needs it back, so nobody gets it.
    await expect(as(db, "authenticated", `select p256dh from public.push_subscription`, ANA)).rejects.toThrow(/permission denied/);
    await expect(as(db, "authenticated", `select auth from public.push_subscription`, ANA)).rejects.toThrow(/permission denied/);
    // The positive control: the columns they MAY read come back — endpoint among them, because
    // "turn off" deletes by it and a WHERE clause needs SELECT on the column it names.
    const ok = await as(db, "authenticated", `select id, person_id, endpoint, created_at from public.push_subscription`, ANA);
    expect(ok.rows).toHaveLength(2);
    // ...and reading it is still only ever their own row.
    const other = await as(db, "authenticated", `select endpoint from public.push_subscription`, BO);
    expect(other.rows).toEqual([{ endpoint: endpointOf("bo") }]);
  });

  it("turning off deletes their own row and cannot touch anyone else's", async () => {
    const gone = await as(
      db,
      "authenticated",
      `delete from public.push_subscription where endpoint = '${endpointOf("ana", 2)}' returning id`,
      ANA,
    );
    expect(gone.rows).toHaveLength(1);
    // Bo aiming at Ana's remaining row matches zero rows — a refusal, not a success.
    const stolen = await as(
      db,
      "authenticated",
      `delete from public.push_subscription where endpoint = '${endpointOf("ana", 1)}' returning id`,
      BO,
    );
    expect(stolen.rows).toEqual([]);
    const still = await as(db, "authenticated", `select id from public.push_subscription`, ANA);
    expect(still.rows).toHaveLength(1);
  });

  it("anon is refused outright, before any policy is consulted", async () => {
    await expect(as(db, "anon", `select id from public.push_subscription`)).rejects.toThrow(/permission denied/);
    await expect(
      as(db, "anon", `insert into public.push_subscription (person_id, endpoint, p256dh, auth) values ('${ANA}', 'https://x/1', 'a', 'b')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("the server reads every subscription with its keys, and may delete a dead one — but writes none", async () => {
    const all = await as(db, "service_role", `select person_id, endpoint, p256dh, auth from public.push_subscription`);
    expect(all.rows).toHaveLength(2); // ana's remaining one and bo's
    // No insert grant: a subscription exists because a browser made it, never because the server did.
    await expect(
      as(db, "service_role", `insert into public.push_subscription (person_id, endpoint, p256dh, auth) values ('${ANA}', 'https://x/9', 'a', 'b')`),
    ).rejects.toThrow(/permission denied/);
  });

  it("a deleted person takes their subscriptions with them", async () => {
    // on delete cascade: an endpoint outliving its owner is a push to a phone whose person row is
    // gone, and there would be nothing left to associate it with.
    await db.exec(`insert into auth.users (id) values ('11111111-2222-4333-8444-555555555555');
      insert into public.person (id, display_name, adult_attested_at) values ('11111111-2222-4333-8444-555555555555', 'Temp', now());`);
    await as(
      db,
      "authenticated",
      `insert into public.push_subscription (person_id, endpoint, p256dh, auth)
       values ('11111111-2222-4333-8444-555555555555', 'https://push.example/temp/1', 'a', 'b')`,
      "11111111-2222-4333-8444-555555555555",
    );
    await db.exec(`delete from public.person where id = '11111111-2222-4333-8444-555555555555';`);
    const left = await db.query(`select id from public.push_subscription where endpoint = 'https://push.example/temp/1'`);
    expect(left.rows).toEqual([]);
  });
});

describe("suggestion.pushed_at — the push half of the ledger (AC 4)", () => {
  it("only the service role may set it, and only that column", async () => {
    await db.exec(`insert into public.suggestion (post_id, person_id, rung) values ('${POST}', '${ANA}', 1);`);
    await expect(
      as(db, "authenticated", `update public.suggestion set pushed_at = now() where post_id = '${POST}'`, ANA),
    ).rejects.toThrow(/permission denied/);
    const ok = await as(
      db,
      "service_role",
      `update public.suggestion set pushed_at = now() where post_id = '${POST}' and person_id = '${ANA}' returning pushed_at`,
    );
    expect(ok.rows).toHaveLength(1);
    expect((ok.rows[0] as { pushed_at: Date | null }).pushed_at).not.toBeNull();
    // ...and it still may not touch the columns 0010 withheld.
    await expect(as(db, "service_role", `update public.suggestion set rung = 3 where post_id = '${POST}'`)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("push_install_status() — the bet's instrument, without leaking an endpoint (AC 6)", () => {
  it("an admin gets a row per person carrying a COUNT, and no endpoint anywhere in it", async () => {
    const r = await as(db, "authenticated", `select person_id, devices from public.push_install_status()`, ADMIN);
    const byPerson = new Map((r.rows as { person_id: string; devices: number }[]).map((x) => [x.person_id, x.devices]));
    expect(byPerson.get(ANA)).toBe(1);
    expect(byPerson.get(BO)).toBe(1);
    expect(byPerson.get(ADMIN)).toBe(0);
    // The shape is the guarantee: two columns, neither of them an endpoint.
    expect(Object.keys(r.rows[0] as object).sort()).toEqual(["devices", "person_id"]);
  });

  it("refuses a signed-in non-admin with 42501, whatever the page believed", async () => {
    await expect(as(db, "authenticated", `select * from public.push_install_status()`, ANA)).rejects.toThrow(/not an admin/);
  });

  it("refuses anon — revoked from public AND from anon by name", async () => {
    // The hosted project grants anon execute on every new function directly, which `revoke … from
    // public` does not reach (cairn: postgrest-probing-a-live-project §4).
    const grants = await db.query<{ pub: boolean; anon: boolean; auth: boolean }>(
      `select has_function_privilege('public', 'public.push_install_status()', 'execute') as pub,
              has_function_privilege('anon', 'public.push_install_status()', 'execute') as anon,
              has_function_privilege('authenticated', 'public.push_install_status()', 'execute') as auth`,
    );
    expect(grants.rows).toEqual([{ pub: false, anon: false, auth: true }]);
  });

  it("counts people with no devices as zero rather than omitting them — the denominator is everyone", async () => {
    // ADR 007's trigger is a proportion. A function that returned only installed people would
    // make the denominator unknowable and the kill condition unreadable.
    const r = await as(db, "authenticated", `select count(*)::int as n from public.push_install_status()`, ADMIN);
    const people = await db.query<{ n: number }>(`select count(*)::int as n from public.person`);
    expect(r.rows).toEqual(people.rows);
  });
});
