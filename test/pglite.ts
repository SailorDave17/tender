/**
 * The pglite harness: applies supabase/migrations/*.sql to an in-memory Postgres and exposes a
 * way to run SQL as a Supabase role.
 *
 * Known blindness, stated rather than discovered (cairn: a-stubbed-default-cannot-report-the-
 * platform-moved-2026-08-13): this harness creates the `anon`, `authenticated` and `service_role` roles itself
 * and grants nothing Supabase would not, but it cannot see a grant the live project has and the
 * migrations lack. `npm run check:live` is the instrument for the live project.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
}

/** The one file whose name starts with `prefix` — throws when that is not exactly one. */
async function fileFor(prefix: string): Promise<string> {
  const hits = (await migrationFiles()).filter((f) => f.startsWith(prefix));
  if (hits.length !== 1) {
    throw new Error(`migration prefix "${prefix}" matches ${hits.length} files: [${hits.join(", ")}]`);
  }
  return hits[0];
}

/** Apply one migration by number prefix, to a db built with `through:`. */
export async function applyMigration(db: PGlite, prefix: string): Promise<void> {
  await db.exec(await readFile(join(MIGRATIONS, await fileFor(prefix)), "utf8"));
}

export type FreshDbOptions = {
  /**
   * Stop after the migration whose name starts with this prefix, so a fixture can exist BEFORE a
   * later migration runs — the only way to test a backfill or a renumber, since the default form
   * applies every file before any test can insert a row (the trap #64's AC 2 walked into).
   *
   * An unmatched prefix THROWS rather than falling back to "apply everything": the fallback is
   * indistinguishable from the option working, and the test would then assert a post-migration
   * state while believing it was pre-migration.
   */
  through?: string;
};

export async function freshDb(options: FreshDbOptions = {}): Promise<PGlite> {
  const db = new PGlite();
  // The roles and the auth shim Supabase provides and pglite does not. auth.users is the one
  // column person.id references; the real table has many more and none is read here.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
  `);
  const stopAfter = options.through === undefined ? null : await fileFor(options.through);
  for (const f of await migrationFiles()) {
    await db.exec(await readFile(join(MIGRATIONS, f), "utf8"));
    if (f === stopAfter) break;
  }
  return db;
}

/**
 * Run `sql` as a Supabase role, optionally as a signed-in user. service_role (since 0010) is
 * created `bypassrls`, as Supabase's is, so a case against it measures grants alone.
 */
export async function as(
  db: PGlite,
  role: "anon" | "authenticated" | "service_role",
  sql: string,
  userId?: string,
) {
  await db.exec(`set role ${role};`);
  // Always set the claim, to '' when there is no user: set_config is session-wide, so a call with
  // no userId after a call with one would otherwise still run as that user.
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role;`);
  }
}
