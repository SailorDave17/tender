import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "./pglite";

/**
 * 0015 — what `anon` may do, and what `authenticated` may do to `club` (story #48).
 *
 * These assertions are only worth anything because `test/pglite.ts` now reproduces Supabase's
 * default privileges for `anon` and `authenticated` before applying the migrations. Without that,
 * every one of them passes on an empty schema and on a wide-open one alike: the harness would
 * simply never have granted anything to take away (cairn:
 * a-stubbed-default-cannot-report-the-platform-moved-2026-08-13). Each block therefore carries a
 * POSITIVE CONTROL — something the same query CAN see — so that an empty result reads as
 * "revoked" rather than as "asked wrong".
 *
 * Two of these are sweeps over the whole schema rather than assertions about the tables 0015
 * happened to find. That is deliberate and is the half with a future: a migration added next year
 * that forgets to revoke its own table, or its own function from PUBLIC, is red here before it is
 * pasted — which is the failure mode this story was filed for, found on the live project two
 * months after the fact.
 */

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

/** The four a client could do damage with. TRUNCATE/REFERENCES/TRIGGER are covered by the sweep. */
const DML = ["select", "insert", "update", "delete"] as const;

describe("0015 — anon holds nothing on club (AC 1)", () => {
  it("shows no privilege for anon in role_table_grants, and the catalog can see one", async () => {
    // The control first: the owner's own grant on the same table, through the same view. Without
    // it, an empty read below is equally consistent with the view being the wrong instrument.
    const control = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants
        where grantee = current_user and table_schema = 'public' and table_name = 'club'`,
    );
    expect(control.rows[0].n).toBeGreaterThan(0);

    const r = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_schema = 'public' and table_name = 'club'
        order by privilege_type`,
    );
    expect(r.rows).toEqual([]);
  });

  it("refuses anon every DML verb on club, by the catalog rather than by a policy", async () => {
    // role_table_grants above lists grants made BY NAME. has_table_privilege answers the question
    // that actually matters — may this role do it, by any route, PUBLIC included — and it is the
    // reading that caught the three functions PUBLIC had granted (see 0015's header).
    const r = await db.query<Record<string, boolean>>(
      `select ${DML.map((p) => `has_table_privilege('anon', 'public.club', '${p}') as "${p}"`).join(", ")}`,
    );
    expect(r.rows[0]).toEqual({ select: false, insert: false, update: false, delete: false });
  });
});

describe("0015 — the sweep: anon holds nothing on ANY table", () => {
  it("names every table anon can still reach, and the sweep is over a non-empty set", async () => {
    const tables = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(tables.rows.length).toBeGreaterThan(10); // the sweep read a schema, not an empty one

    const offenders: string[] = [];
    let controlHits = 0;
    for (const { tablename } of tables.rows) {
      for (const p of DML) {
        const r = await db.query<{ anon: boolean; auth: boolean }>(
          `select has_table_privilege('anon', 'public.${tablename}', '${p}') as anon,
                  has_table_privilege('authenticated', 'public.${tablename}', '${p}') as auth`,
        );
        if (r.rows[0].anon) offenders.push(`${tablename}.${p}`);
        if (r.rows[0].auth) controlHits++;
      }
    }
    // The control: the identical query, asked about the role that IS meant to reach these tables,
    // returns plenty. So `offenders` being empty is a fact about anon, not about the query.
    expect(controlHits).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe("0015 — the sweep: anon may execute no function in public", () => {
  it("names every function anon can still call, and proves authenticated still can", async () => {
    const fns = await db.query<{ oid: number; sig: string }>(
      `select p.oid::int as oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by sig`,
    );
    expect(fns.rows.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    let controlHits = 0;
    for (const { oid, sig } of fns.rows) {
      const r = await db.query<{ anon: boolean; auth: boolean }>(
        `select has_function_privilege('anon', ${oid}, 'execute') as anon,
                has_function_privilege('authenticated', ${oid}, 'execute') as auth`,
      );
      if (r.rows[0].anon) offenders.push(sig);
      if (r.rows[0].auth) controlHits++;
    }
    // Control: `authenticated` still executes the ones the app calls. 0015 revokes EXECUTE from
    // PUBLIC as well as from anon, and PUBLIC is where `authenticated` reached three of these
    // from — so a revoke one word wider would have taken the app's own access with it.
    expect(controlHits).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});

describe("0015 — authenticated on club", () => {
  it("holds no whole-table privilege", async () => {
    const control = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.table_privileges
        where grantee = current_user and table_schema = 'public' and table_name = 'club'`,
    );
    expect(control.rows[0].n).toBeGreaterThan(0);

    const r = await db.query<{ privilege_type: string }>(
      `select distinct privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'club'
        order by privilege_type`,
    );
    expect(r.rows).toEqual([]);
  });

  it("keeps 0002's five column SELECT grants — the reason 0015 names privileges instead of ALL", async () => {
    // `revoke all on public.club from authenticated` would have stripped these silently, and the
    // club name and theme are on every screen (cairn: supabase-rls-column-grants-2026-08-06).
    // test/person.test.ts holds the same list across three tables; this is the local guard on the
    // one decision 0015 makes.
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where grantee = 'authenticated' and table_schema = 'public' and table_name = 'club'
          and privilege_type = 'SELECT'
        order by column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      "brand_disc",
      "brand_mark",
      "created_at",
      "id",
      "name",
    ]);
  });
});

describe("0015 — what an object created AFTER it inherits", () => {
  it("gives anon nothing on a new table or sequence, while authenticated still inherits both", async () => {
    // This is the only exercise the `alter default privileges` lines get: every table that exists
    // today is covered by the sweep statement instead, so deleting those lines reddens nothing
    // without a probe that did not exist when they ran (cairn:
    // a-mutation-certifies-the-corpus-not-the-guard-2026-08-20 — an unexercised defence is
    // byte-identical to dead code).
    try {
      await db.exec(`create table public.__anon_probe_t (id int);
                     create sequence public.__anon_probe_s;`);
      const r = await db.query<Record<string, boolean>>(
        `select has_table_privilege('anon', 'public.__anon_probe_t', 'select') as t_anon,
                has_table_privilege('authenticated', 'public.__anon_probe_t', 'select') as t_auth,
                has_sequence_privilege('anon', 'public.__anon_probe_s', 'usage') as s_anon,
                has_sequence_privilege('authenticated', 'public.__anon_probe_s', 'usage') as s_auth`,
      );
      // t_auth/s_auth are the control: the reproduced platform default IS in force at this moment,
      // so anon's absence is 0015 removing it rather than the harness never having granted it.
      expect(r.rows[0]).toEqual({ t_anon: false, t_auth: true, s_anon: false, s_auth: true });
    } finally {
      await db.exec(`drop table if exists public.__anon_probe_t;
                     drop sequence if exists public.__anon_probe_s;`);
    }
  });

  it("STILL lets anon execute a new function — the default-privileges mechanism cannot reach PUBLIC", async () => {
    // Not a defect being tolerated quietly: it is the measurement 0015's header rests on, held by
    // a test so that it cannot rot in prose. Postgres grants EXECUTE on every new function to
    // PUBLIC as a built-in default, and `pg_default_acl` records only ADDITIONS to that default,
    // so there is nothing for `alter default privileges … revoke … from public` to remove — six
    // spellings measured, all six leaving `=X/postgres` on the new function.
    //
    // If this ever goes GREEN — a Postgres change, or a Supabase one — that is good news and
    // 0015's header is then wrong. Correct the header; do not delete the assertion.
    try {
      await db.exec(`create function public.__anon_probe_f() returns int language sql as $$ select 1 $$;
                     create role __anon_probe_r nologin;`);
      const r = await db.query<{ anon: boolean; via_public: boolean }>(
        `select has_function_privilege('anon', 'public.__anon_probe_f()'::regprocedure, 'execute') as anon,
                has_function_privilege('__anon_probe_r', 'public.__anon_probe_f()'::regprocedure, 'execute') as via_public
           from pg_proc where oid = 'public.__anon_probe_f()'::regprocedure`,
      );
      expect(r.rows[0].anon).toBe(true);
      // …and by which ROUTE, because that is the half that decides whether a migration could ever
      // close it. `__anon_probe_r` is created in this test with nothing granted to it by anything,
      // so if it can call the function the grant can only be PUBLIC's — no premise about how the
      // harness is configured, which is what the first version of this line got wrong.
      //
      // That version read the ACL text for `=X/`, and it was an assertion about the CATALOG'S
      // REPRESENTATION rather than about the claim: with no `pg_default_acl` row at all, `proacl`
      // is NULL and the built-in default applies invisibly. *Measured* — the harness-config
      // mutation reddened that line while `anon` was still true, which is the claim holding and
      // the assertion failing.
      expect(r.rows[0].via_public).toBe(true);
    } finally {
      await db.exec(`drop function if exists public.__anon_probe_f();
                     drop role if exists __anon_probe_r;`);
    }
  });
});
