#!/usr/bin/env node
/**
 * perf:floor — measure the board and post pages against the performance floors. Story #44.
 *
 *     npm run perf:floor -- --db-container supabase_db_<dir> --base-url http://localhost:3100
 *
 * It prices levers against the floors; it does not decide the framework. ADR 002's lab kill
 * condition was retired as the framework trigger on 2026-09-22 (#213), and ADR 002's framework
 * trigger is now field data from members' phones, which this command does not read. A failing
 * floor is a lever to price — see docs/performance-floor.md.
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
 * The floors are about a mid-range Android on a real network, which a local serve cannot price for
 * this page shape. Two more shapes of run reach a deployed build without weakening the
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
 *
 * `--throttling-method devtools` (#216) throttles the real network and CPU instead of simulating
 * them, which is the only way hydration cost shows up at all. Each route's summary records the
 * method Lighthouse reports having used, plus the host's `benchmarkIndex`. See `THROTTLING_METHODS`
 * and `BENCHMARK_BAND` in the core for why a devtools reading without that index cannot be read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  FLOORS,
  adminEmailFor,
  buildSummary,
  fixturePlan,
  fixtureSql,
  formatReport,
  lighthouseArgs,
  measuredViewer,
  parseArgs,
  readReport,
  refuseWrongPage,
  requestHeaders,
  runTarget,
  summariseRoute,
  verdict,
} from "./lighthouse-floor-core.mjs";
// Docker, GoTrue and the session cookie, shared with `field-vitals.mjs` since #215.
import { FIXTURE_PASSWORD, assertSignedIn, mintPeople, psql, sessionCookieHeader } from "./stack-session.mjs";

function runLighthouse({ url, headersFile, outPath, chromePath, throttlingMethod }) {
  const args = lighthouseArgs({ url, headersFile, outPath, throttlingMethod });
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
      process.stderr.write(`Lighthouse ${route} run ${run}/${args.runs} (${args.throttlingMethod})...\n`);
      const lhr = runLighthouse({ url, headersFile, outPath, chromePath, throttlingMethod: args.throttlingMethod });
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
      buildSummary({
        takenAt: new Date().toISOString(),
        // Where it was measured. No viewer address and no secret: this file gets committed.
        target: { baseUrl: args.baseUrl, seeded: args.seed, servedSupabaseUrl: args.servedSupabaseUrl ?? args.stack },
        volume: target.volume,
        summaries,
        verdict: v,
      }),
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
