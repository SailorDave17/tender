/**
 * The pglite harness: applies supabase/migrations/*.sql to an in-memory Postgres and exposes a
 * way to run SQL as a Supabase role.
 *
 * Known blindness, stated rather than discovered (cairn: a-stubbed-default-cannot-report-the-
 * platform-moved-2026-08-13): this harness creates the `anon` and `authenticated` roles itself
 * and grants nothing Supabase would not, but it cannot see a grant the live project has and the
 * migrations lack. `npm run check:live` is the instrument for the live project.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  // The roles and the auth shim Supabase provides and pglite does not.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    await db.exec(await readFile(join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

/** Run `sql` as a Supabase role, optionally as a signed-in user. */
export async function as(
  db: PGlite,
  role: "anon" | "authenticated",
  sql: string,
  userId?: string,
) {
  await db.exec(`set role ${role};`);
  if (userId) await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false);`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec(`reset role;`);
  }
}
