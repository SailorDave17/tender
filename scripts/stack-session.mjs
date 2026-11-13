/**
 * What a measuring script needs from a local Supabase stack: SQL in its database, the fixture's
 * people in GoTrue, and a signed-in session as a real cookie header. Docker and the network, and
 * nothing that decides an outcome.
 *
 * `lighthouse-floor.mjs` (#44) held these three until #215 added a second runner that seeds the
 * same fixture and signs in as the same viewer (`field-vitals.mjs`). They were moved, not
 * rewritten: a second copy of the cookie step is the one copy that must not exist, for the reason
 * `sessionCookieHeader` gives.
 */

import { spawnSync } from "node:child_process";

import { createServerClient } from "@supabase/ssr";

/** Every fixture person's password. Loopback stacks only: each runner refuses anything else before seeding. */
export const FIXTURE_PASSWORD = "fixture-floor-44-pass";

/** Mint the plan's people through GoTrue's admin API. A person already there (422) is not an error. */
export async function mintPeople(stack, serviceKey, people) {
  let created = 0;
  let existing = 0;
  for (const p of people) {
    const r = await fetch(`${stack}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: p.id, email: p.email, password: FIXTURE_PASSWORD, email_confirm: true }),
    });
    if (r.ok) created += 1;
    else if (r.status === 422) existing += 1;
    else throw new Error(`minting ${p.email} failed: ${r.status} ${await r.text()}`);
  }
  return { created, existing };
}

/**
 * SQL on stdin, never `-c "…"`: the `-c` form dies on quoting through cmd.exe, and without `-q`
 * the `INSERT 0 1` tags come back in stdout and land in the next statement (this repo's overlay,
 * from #21).
 */
export function psql(container, sql) {
  const r = spawnSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql failed (${r.status}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * A signed-in session as a real cookie header, with no browser in it.
 *
 * The password grant gives a real GoTrue token pair; `@supabase/ssr`'s own `setSession` then
 * serialises it into whatever cookies that library would have set, read back out of a Map jar.
 * Deriving the cookie name and the base64 chunking by hand would be re-implementing a private
 * format that the app's own dependency already implements — and that is the one thing that must
 * not drift, because the proxy reads these cookies with that same library.
 */
export async function sessionCookieHeader(stack, anonKey, email, password, servedSupabaseUrl = stack) {
  const r = await fetch(`${stack}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = await r.json();
  // The grant's own error body is printed, never the request: the request carries the password.
  if (!token.access_token) throw new Error(`password grant failed: ${r.status} ${JSON.stringify(token)}`);

  // Named for the URL the MEASURED BUILD talks to, which differs from `stack` exactly when that
  // build reaches this stack through a tunnel — see `lighthouse-floor.mjs`'s header.
  const jar = new Map();
  const client = createServerClient(servedSupabaseUrl, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value } of list) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
  });
  if (error) throw new Error(`setSession failed: ${error.message}`);
  if (!jar.size) throw new Error("setSession wrote no cookies — the session would not reach the proxy");
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * A control on the cookie BEFORE a browser is asked to spend minutes on it: fetch the route
 * without following redirects and refuse anything but a 200. A 302 here is the README's
 * build-time-env trap, and catching it costs one request instead of a whole run plus a plausible
 * number.
 */
export async function assertSignedIn(baseUrl, route, headers) {
  const r = await fetch(new URL(route, baseUrl), { headers, redirect: "manual" });
  if (r.status === 200) return;
  const where = r.headers.get("location");
  throw new Error(
    `${route} answered ${r.status}${where ? ` -> ${where}` : ""} for a signed-in cookie.\n` +
      "  The usual cause is that `next build` ran without NEXT_PUBLIC_SUPABASE_URL/ANON_KEY set to\n" +
      "  this stack: they are inlined into the Edge proxy at BUILD time, so the built proxy is\n" +
      "  talking to a different project and this session means nothing to it (README, Working on it).\n" +
      "  Against a preview, a 302 to vercel.com/sso-api means VERCEL_AUTOMATION_BYPASS_SECRET is unset\n" +
      "  or wrong; a 302 to /join means --served-supabase-url does not match the preview's own.",
  );
}
