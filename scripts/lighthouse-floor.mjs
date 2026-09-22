#!/usr/bin/env node
/**
 * perf:floor — measure ADR 002's kill condition with the instrument ADR 002 names. Story #44.
 *
 *     npm run perf:floor -- --db-container supabase_db_<dir> --base-url http://localhost:3100
 *
 * Everything that decides an outcome — the fixture, the score reading, the median, the verdict —
 * is in `lighthouse-floor-core.mjs`, where `test/lighthouse-floor.test.ts` exercises it with no
 * stack, no browser and no network. What is left here is Docker, GoTrue, Chrome and the
 * filesystem, which are the four things a test cannot supply. Same split as `check-live.mjs` and
 * `verify-migrations.mjs`.
 *
 * A SEEDED RUN IS AGAINST A LOCAL STACK, NEVER THE LIVE PROJECT, AND THAT IS ENFORCED RATHER THAN
 * INTENDED. It seeds 80 people, 45 race dates and 50 posts — writes that would be vandalism
 * against production — so `runTarget()` refuses any Supabase URL that is not loopback before a
 * single row is written. Only `--no-seed`, which writes nothing, may name the live project (see
 * *Against a deployment* below).
 *
 * THE TRAP THIS COMMAND IS MOSTLY BUILT AROUND
 *
 * `next build` inlines `NEXT_PUBLIC_*` into the Edge proxy (README, *Working on it*), so a build
 * made without them pointed at the local stack silently gets the LIVE project instead — and then
 * `src/proxy.ts` finds no valid session, 302s to /join, and Lighthouse cheerfully measures /join.
 * /join is a small static form: it scores WELL. So the failure mode of this whole measurement is
 * a reassuring number for a page nobody asked about. `refuseWrongPage()` compares Lighthouse's
 * own `finalDisplayedUrl` against the URL requested and refuses the run on a mismatch, which is
 * the one check that makes the rest of the output worth reading.
 *
 * Both guards, and the choice of WHICH person signs in and WHICH post is opened, live in the core
 * so they can be proven able to refuse without a stack — see `measuredViewer` there, and the
 * measurement defect that made choosing it deliberately necessary.
 *
 * AGAINST A DEPLOYMENT (#185)
 *
 * ADR 002's condition is about a mid-range Android on a real network, which a local serve cannot
 * price for this page shape. Two more shapes of run reach a deployed build without weakening the
 * refusal above:
 *
 * - **A seeded preview.** Seed the local stack as usual, expose it through a tunnel, deploy a
 *   preview whose NEXT_PUBLIC_SUPABASE_URL is the tunnel, and pass that URL as
 *   `--served-supabase-url`. `@supabase/ssr` names its cookie after the Supabase host
 *   (`sb-<first label>-auth-token`), so a cookie minted for 127.0.0.1 means nothing to a build
 *   talking to the tunnel; the token still comes from `--stack`, which stays loopback. Previews sit
 *   behind Vercel's sign-in, so `VERCEL_AUTOMATION_BYPASS_SECRET` in the environment adds the
 *   bypass header (see `requestHeaders`).
 * - **The live project, read-only.** `--no-seed` writes nothing, so it may name any Supabase and a
 *   real viewer (`--viewer`, with `PERF_VIEWER_PASSWORD` in the environment) and routes
 *   (`--route`, repeatable). Such a reading claims no volume (see `runTarget`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createServerClient } from "@supabase/ssr";

import {
  FLOORS,
  adminEmailFor,
  fixturePlan,
  fixtureSql,
  formatReport,
  measuredViewer,
  readReport,
  refuseWrongPage,
  requestHeaders,
  runTarget,
  summariseRoute,
  verdict,
} from "./lighthouse-floor-core.mjs";

const FIXTURE_PASSWORD = "fixture-floor-44-pass";

function parseArgs(argv) {
  const args = {
    stack: "http://127.0.0.1:54321",
    baseUrl: "http://localhost:3100",
    dbContainer: null,
    runs: 3,
    out: "lighthouse",
    seed: true,
    servedSupabaseUrl: null,
    viewer: null,
    routes: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--stack") args.stack = value();
    else if (flag === "--served-supabase-url") args.servedSupabaseUrl = value();
    else if (flag === "--viewer") args.viewer = value();
    else if (flag === "--route") args.routes.push(value());
    else if (flag === "--base-url") args.baseUrl = value();
    else if (flag === "--db-container") args.dbContainer = value();
    else if (flag === "--runs") args.runs = Number(value());
    else if (flag === "--out") args.out = value();
    else if (flag === "--no-seed") args.seed = false;
    // An unknown flag is refused rather than ignored, as `migrate-live.mjs` refuses one: a
    // silently dropped flag here is a run measuring something other than what was asked for.
    else if (flag.startsWith("--")) throw new Error(`unknown flag ${flag}`);
  }
  if (!args.dbContainer && args.seed) throw new Error("--db-container is required to seed (e.g. supabase_db_stack)");
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs must be a positive integer");
  return args;
}

async function mintPeople(stack, serviceKey, people) {
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
function psql(container, sql) {
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
async function sessionCookieHeader(stack, anonKey, email, password, servedSupabaseUrl = stack) {
  const r = await fetch(`${stack}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = await r.json();
  // The grant's own error body is printed, never the request: the request carries the password.
  if (!token.access_token) throw new Error(`password grant failed: ${r.status} ${JSON.stringify(token)}`);

  // Named for the URL the MEASURED BUILD talks to, which differs from `stack` exactly when that
  // build reaches this stack through a tunnel — see the file header.
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
 * A control on the cookie BEFORE Lighthouse is asked to spend two minutes on it: fetch the route
 * without following redirects and refuse anything but a 200. A 302 here is the README's
 * build-time-env trap, and catching it costs one request instead of a whole run plus a plausible
 * number.
 */
async function assertSignedIn(baseUrl, route, headers) {
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

function runLighthouse({ url, headersFile, outPath, chromePath }) {
  const args = [
    "--yes",
    "lighthouse@12",
    JSON.stringify(url),
    "--form-factor=mobile",
    "--screenEmulation.mobile",
    "--throttling-method=simulate",
    "--only-categories=performance,accessibility",
    `--extra-headers=${JSON.stringify(headersFile)}`,
    "--output=json",
    `--output-path=${JSON.stringify(outPath)}`,
    '--chrome-flags="--headless=new"',
    "--quiet",
  ];
  // A report left by an EARLIER invocation at this same path would otherwise be read as this
  // run's when lighthouse writes nothing at all (cairn: an-absent-result-reads-as-a-clean-one).
  // The path is deterministic per route and run, so deleting first is what makes the read honest.
  if (existsSync(outPath)) rmSync(outPath);
  const r = spawnSync("npx", args, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...(chromePath ? { CHROME_PATH: chromePath } : {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  // chrome-launcher can exit non-zero AFTER the report is on disk — its temp-profile cleanup
  // races the antivirus on this machine. The report is the artefact; the exit code is about
  // cleanup (cairn: lighthouse-simulated-scores-race-the-font-files-2026-09-04, fact 2). So the
  // file is the test, and each run writes a fresh path so a stale one cannot pass for this one.
  let raw;
  try {
    raw = readFileSync(outPath, "utf8");
  } catch {
    throw new Error(`lighthouse wrote no report (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  if (r.status !== 0) process.stderr.write(`  (lighthouse exited ${r.status} with the report written; continuing)\n`);
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = fixturePlan();
  // Refuses a seeded run against anything but loopback, before a key is even read.
  const target = runTarget({ seed: args.seed, stack: args.stack, viewerEmail: args.viewer, routes: args.routes, plan });

  const keys = {
    anon: process.env.STACK_ANON_KEY,
    service: process.env.STACK_SERVICE_ROLE_KEY,
  };
  if (!keys.anon) throw new Error("set STACK_ANON_KEY — the anon key of the Supabase at --stack");
  if (args.seed && !keys.service) {
    throw new Error("set STACK_SERVICE_ROLE_KEY from the stack's own `supabase start` output — seeding needs it");
  }
  const password = target.fixtureViewer ? FIXTURE_PASSWORD : process.env.PERF_VIEWER_PASSWORD;
  if (!password) throw new Error("--viewer needs PERF_VIEWER_PASSWORD in the environment");

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  if (args.seed) {
    process.stderr.write(`Seeding ${plan.people.length} people through GoTrue's admin API...\n`);
    const minted = await mintPeople(args.stack, keys.service, plan.people);
    process.stderr.write(`  ${minted.created} created, ${minted.existing} already present\n`);
    process.stderr.write("Seeding the club, dates, boats, posts, matches, availability and answers...\n");
    psql(args.dbContainer, fixtureSql(plan, { adminEmail: adminEmailFor(plan) }));
    const counts = psql(
      args.dbContainer,
      "select 'race_date='||count(*) from race_date union all select 'post='||count(*) from post " +
        "union all select 'match='||count(*) from match union all select 'availability='||count(*) from availability " +
        "union all select 'person='||count(*) from person;",
    );
    process.stderr.write(`  ${counts.trim().split("\n").join(", ")}\n`);
  }

  process.stderr.write("Minting a signed-in session cookie...\n");
  if (target.fixtureViewer) {
    const viewer = measuredViewer(plan);
    process.stderr.write(`  signing in as ${viewer.email} (rated ${viewer.rating}, not the club admin, owns an open post)\n`);
  } else {
    // A named viewer is a real account; its address is not printed, since run logs get pasted.
    process.stderr.write("  signing in as the viewer named by --viewer\n");
  }
  const cookie = await sessionCookieHeader(
    args.stack,
    keys.anon,
    target.email,
    password,
    args.servedSupabaseUrl ?? args.stack,
  );
  const headers = requestHeaders({ cookie, bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? null });
  const headersFile = join(outDir, "extra-headers.json");
  writeFileSync(headersFile, JSON.stringify(headers, null, 2));

  // Both routes, with the post resolved to the arm the viewer was chosen for — the OPEN post
  // they own, which renders the full candidate list. `measuredViewer` in the core carries why,
  // and why a MATCHED post is the light arm rather than the heavy one it was first taken for.
  const { routes } = target;
  for (const route of routes) await assertSignedIn(args.baseUrl, route, headers);
  process.stderr.write(`  ${routes.length} route(s) answer 200 for this session\n`);

  const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const summaries = [];
  const written = [];
  for (const route of routes) {
    const reports = [];
    for (let run = 1; run <= args.runs; run += 1) {
      const url = new URL(route, args.baseUrl).toString();
      const outPath = join(outDir, `${route.replaceAll("/", "_").replace(/^_/, "")}-run${run}.json`);
      process.stderr.write(`Lighthouse ${route} run ${run}/${args.runs}...\n`);
      const lhr = runLighthouse({ url, headersFile, outPath, chromePath });
      const wrongPage = refuseWrongPage(url, lhr);
      if (wrongPage) throw new Error(wrongPage);
      reports.push(readReport(lhr));
      written.push(outPath);
    }
    summaries.push(summariseRoute(route, reports));
  }

  const v = verdict(summaries, FLOORS);
  const summaryPath = join(outDir, "summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        // Where it was measured. No viewer address and no secret: this file gets committed.
        target: { baseUrl: args.baseUrl, seeded: args.seed, servedSupabaseUrl: args.servedSupabaseUrl ?? args.stack },
        // null when the run named its own viewer or routes — the doc states that volume by hand.
        volume: target.volume,
        floors: FLOORS,
        summaries,
        verdict: v,
      },
      null,
      2,
    ),
  );

  process.stdout.write(`\n${formatReport(summaries, v, FLOORS)}\n\n`);
  process.stdout.write(`Reports: ${written.length + 1} files in ${outDir}\n`);
  if (!v.pass) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`\n${e.message}\n`);
  process.exitCode = 1;
});
