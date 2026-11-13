#!/usr/bin/env node
/**
 * perf:field — can any metric a phone reports see /board's hydration cost? Story #215.
 *
 *     npm run perf:field -- --db-container supabase_db_<dir> --base-url http://localhost:3100
 *
 * with STACK_ANON_KEY and STACK_SERVICE_ROLE_KEY set to the stack's own keys, against a
 * `next build` + `next start` made with that stack's keys (docs/performance-floor.md, *Running
 * it*). It loads /board as `perf:floor`'s measured viewer on two fixtures that differ only in
 * their date count, in mobile Chrome with the CPU slowed 4x, taps the first day's availability
 * toggle at a fixed time after navigation start, and reads LCP, INP with its three phases, and the
 * blocking time of long animation frames, as Next's own `web-vitals` attribution build reports
 * them. Then it says which of those metrics tell the two boards apart.
 *
 * Everything that decides an outcome — the two boards, the seed, how a run is read and refused,
 * the spread, the label — is in `field-vitals-core.mjs`, where `test/field-vitals.test.ts`
 * exercises it with no stack and no browser. What is left here is Docker, GoTrue, Chrome and the
 * page. Same split as `lighthouse-floor.mjs`.
 *
 * THIS RUNS AGAINST A LOCAL STACK, NEVER THE LIVE PROJECT, AND THAT IS ENFORCED. Every run
 * truncates the race dates and everything hanging off them and seeds a fixture, so
 * `refuseNonLocalStack()` refuses any Supabase URL that is not loopback before anything is sent.
 *
 * WHAT A RUN IS
 *
 * 1. Reseed the arm's board, so every run starts from the same rows in the same order.
 * 2. A new browser context (cold cache), Lighthouse's mobile viewport, touch on, the session
 *    cookie set, the CPU slowed with `Emulation.setCPUThrottlingRate`.
 * 3. Two init scripts: Next's attribution build, then a collector that keeps what it reports in
 *    `sessionStorage`. That store outlives the document, which matters because a tap before
 *    hydration is a plain form post and replaces the page.
 * 4. Navigate, wait until the fixed offset after the document's own `timeOrigin`, tap.
 * 5. Leave the page alone for the settle time, then read the store.
 *
 * The runs are interleaved (one of each board and offset per round, in alternating order) so a
 * host that warms up or slows down during the session does so to both boards alike.
 *
 * WHAT IT CANNOT SEE. The network is not throttled: this is localhost, and only the CPU is slowed.
 * The CPU is whatever ran it, slowed 4x; `perf:floor --throttling-method devtools` prints the
 * host's `benchmarkIndex`, and this command does not. And it is Chrome: Safari and Firefox report
 * fewer of these metrics (the support table is in docs/performance-floor.md).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { chromium } from "playwright-core";

import { median, refuseNonLocalStack } from "./lighthouse-floor-core.mjs";
import {
  ARMS,
  METRICS,
  MIN_RUNS,
  STORE_PREFIX,
  UNSLOWED_LOADS,
  VIEWPORT,
  WEB_VITALS_BUILD,
  armBoard,
  buildSummary,
  formatReport,
  parseArgs,
  readRun,
  refuseRun,
  refuseUnslowed,
  seedSql,
  summariseRuns,
  unslowedReference,
  wrapWebVitals,
} from "./field-vitals-core.mjs";
import { FIXTURE_PASSWORD, assertSignedIn, mintPeople, psql, sessionCookieHeader } from "./stack-session.mjs";

const require = createRequire(import.meta.url);
const ROUTE = "/board";
/** A run that has not finished in this long is hung, not slow (the tap and the settle are ~10 s). */
const RUN_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Runs IN THE PAGE, before any of its own scripts. It keeps each metric's latest report, every
 * long animation frame, and two moments: when the toggle entered the document, and when React
 * hydrated it (React hangs a `__reactProps$…` key on a node as it hydrates it).
 *
 * Everything is written to `sessionStorage` as it arrives, never held for a final read: when the
 * tap replaces the document, a final read would be of the wrong page.
 */
function collectInPage({ prefix, selector }) {
  const key = prefix + Math.round(performance.timeOrigin);
  const state = { timeOrigin: performance.timeOrigin, url: location.href, metrics: {}, loaf: [], loafSupported: false, targetAt: null, hydratedAt: null };
  const save = () => {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // A full or refused store loses this write; the run is then refused for what is missing.
    }
  };
  const keep = (metric) => {
    const kept = { value: metric.value, rating: metric.rating, navigationType: metric.navigationType };
    for (const [name, v] of Object.entries(metric.attribution ?? {})) {
      if (typeof v === "number" || typeof v === "string") kept[name] = v;
    }
    state.metrics[metric.name] = kept;
    save();
  };
  const vitals = window.__tenderWebVitals;
  for (const on of ["onLCP", "onINP", "onCLS", "onFCP", "onTTFB"]) vitals[on](keep, { reportAllChanges: true });
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    state.loafSupported = true;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.loaf.push({ startTime: e.startTime, duration: e.duration, blockingDuration: e.blockingDuration });
      }
      save();
    }).observe({ type: "long-animation-frame", buffered: true });
  }
  const timer = setInterval(() => {
    const target = document.querySelector(selector);
    if (!target) return;
    if (state.targetAt == null) {
      state.targetAt = performance.now();
      save();
    }
    if (Object.keys(target).some((k) => k.startsWith("__reactProps$"))) {
      state.hydratedAt = performance.now();
      save();
      clearInterval(timer);
    }
  }, 20);
  save();
}

/** Flush what `web-vitals` holds until the page is hidden, then hand back every document's record. */
function readPage({ prefix, selector }) {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  const store = {};
  for (const k of Object.keys(sessionStorage)) {
    if (k.startsWith(prefix)) store[k] = JSON.parse(sessionStorage.getItem(k));
  }
  const target = document.querySelector(selector);
  return {
    store,
    pressedAfter: target ? target.getAttribute("aria-pressed") : null,
    rowsAfter: document.querySelectorAll("ol[data-race-days] > li").length,
  };
}

/** Where the toggle is, read once per board on an unslowed load that also warms the server. */
function locateTarget(selector) {
  const target = document.querySelector(selector);
  if (!target) return { found: false };
  const r = target.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  return {
    found: true,
    x,
    y,
    inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
    hit: document.elementFromPoint(x, y) === target,
    pressed: target.getAttribute("aria-pressed"),
    rows: document.querySelectorAll("ol[data-race-days] > li").length,
    elements: document.querySelectorAll("*").length,
  };
}

const contextOptions = {
  viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
  deviceScaleFactor: VIEWPORT.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
};

async function newPage(browser, baseUrl, cookieHeader) {
  const context = await browser.newContext(contextOptions);
  await context.addCookies(
    cookieHeader.split("; ").map((pair) => {
      const i = pair.indexOf("=");
      return { name: pair.slice(0, i), value: pair.slice(i + 1), url: baseUrl };
    }),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { context, page };
}

async function calibrate(browser, args, board, cookieHeader) {
  psql(args.dbContainer, seedSql(board));
  const { context, page } = await newPage(browser, args.baseUrl, cookieHeader);
  try {
    await page.goto(new URL(ROUTE, args.baseUrl).toString(), { waitUntil: "networkidle" });
    const at = await page.evaluate(locateTarget, board.tapSelector);
    if (!at.found) throw new Error(`${board.arm.name}: the first day's toggle is not on the page`);
    if (at.rows !== board.rows) throw new Error(`${board.arm.name}: the board rendered ${at.rows} day rows, not ${board.rows}`);
    if (at.pressed !== "true") throw new Error(`${board.arm.name}: the first day's toggle is not pressed, so the tap would mark the day instead of taking it back`);
    if (!at.inViewport || !at.hit) throw new Error(`${board.arm.name}: the first day's toggle is off screen or covered, so a tap at its centre would miss it`);
    return { x: Math.round(at.x), y: Math.round(at.y), elements: at.elements };
  } finally {
    await context.close();
  }
}

/**
 * The same load with the collector and NO slowdown, after `calibrate` has warmed the server. Its
 * hydration time is what the slowed runs are held against (`refuseUnslowed`), and it doubles as a
 * reading of how fast this host is.
 *
 * Three loads, folded by `unslowedReference`: one load is not a reading of this page, whose
 * unslowed hydration lands at about 170 ms or about 420 ms from one load to the next.
 */
async function unslowedLoad(browser, args, board, cookieHeader, wrapped) {
  const loads = [];
  for (let i = 0; i < UNSLOWED_LOADS; i += 1) {
    const { context, page } = await newPage(browser, args.baseUrl, cookieHeader);
    try {
      await page.addInitScript({ content: wrapped });
      await page.addInitScript(collectInPage, { prefix: STORE_PREFIX, selector: board.tapSelector });
      await page.goto(new URL(ROUTE, args.baseUrl).toString(), { waitUntil: "networkidle" });
      await sleep(1000);
      const idle = readRun(await page.evaluate(readPage, { prefix: STORE_PREFIX, selector: board.tapSelector }));
      loads.push({ hydratedAt: idle.hydratedAt, loafBlocking: idle.loafBlocking });
    } finally {
      await context.close();
    }
  }
  return unslowedReference(loads);
}

async function oneRun(browser, args, board, point, tapAt, cookieHeader, wrapped) {
  psql(args.dbContainer, seedSql(board));
  const { context, page } = await newPage(browser, args.baseUrl, cookieHeader);
  try {
    const cdp = await context.newCDPSession(page);
    await page.addInitScript({ content: wrapped });
    await page.addInitScript(collectInPage, { prefix: STORE_PREFIX, selector: board.tapSelector });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: args.cpuRate });
    await page.goto(new URL(ROUTE, args.baseUrl).toString(), { waitUntil: "commit" });
    // The offset is from the document's own clock, not from when this script asked for the page.
    const origin = await page.evaluate(() => performance.timeOrigin);
    await sleep(origin + tapAt - Date.now());
    // Start and end together, as Playwright's own tap sends them: awaiting the start first would
    // hold the finger down for as long as the page is busy, and a long press is not a tap.
    await page.touchscreen.tap(point.x, point.y);
    await sleep(origin + tapAt + args.settleMs - Date.now());
    const read = await page.evaluate(readPage, { prefix: STORE_PREFIX, selector: board.tapSelector });
    const marked = psql(
      args.dbContainer,
      `select count(*) from public.availability where person_id = '${board.viewer.id}' and race_date_id = '${board.tapDateId}';`,
    ).trim();
    return readRun({ ...read, markedAfter: marked === "1" });
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const refusal = refuseNonLocalStack(args.stack);
  if (refusal) throw new Error(refusal);
  const keys = { anon: process.env.STACK_ANON_KEY, service: process.env.STACK_SERVICE_ROLE_KEY };
  if (!keys.anon) throw new Error("set STACK_ANON_KEY — the anon key of the Supabase at --stack");
  if (!keys.service) throw new Error("set STACK_SERVICE_ROLE_KEY from the stack's own `supabase start` output — seeding needs it");

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const boards = ARMS.map((arm) => armBoard(arm));

  process.stderr.write(`Minting ${boards[0].plan.people.length} people through GoTrue's admin API...\n`);
  const minted = await mintPeople(args.stack, keys.service, boards[0].plan.people);
  process.stderr.write(`  ${minted.created} created, ${minted.existing} already present\n`);
  // Seeded once before signing in, so the 200 asserted below is the board and not an empty stack's
  // answer to a person with no row.
  psql(args.dbContainer, seedSql(boards[0]));
  const cookieHeader = await sessionCookieHeader(args.stack, keys.anon, boards[0].viewer.email, FIXTURE_PASSWORD);
  await assertSignedIn(args.baseUrl, ROUTE, { Cookie: cookieHeader });

  const wrapped = wrapWebVitals(readFileSync(require.resolve(WEB_VITALS_BUILD), "utf8"));
  const nextVersion = require("next/package.json").version;

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const records = [];
  let summary;
  try {
    const points = [];
    for (const board of boards) {
      const point = await calibrate(browser, args, board, cookieHeader);
      point.unslowed = await unslowedLoad(browser, args, board, cookieHeader, wrapped);
      points.push(point);
      process.stderr.write(
        `  ${board.arm.name}: ${board.rows} day rows, ${point.elements} elements, toggle at ${point.x},${point.y}, hydrates at ${Math.round(point.unslowed.hydratedAt ?? NaN)} ms unslowed\n`,
      );
    }

    const cells = boards.flatMap((board, b) => args.tapAt.map((tapAt) => ({ board, point: points[b], tapAt })));
    for (let round = 1; round <= args.runs; round += 1) {
      const order = round % 2 ? cells : [...cells].reverse();
      for (const { board, point, tapAt } of order) {
        process.stderr.write(`Round ${round}/${args.runs}: ${board.arm.name}, tap at ${tapAt} ms...\n`);
        const run = await Promise.race([
          oneRun(browser, args, board, point, tapAt, cookieHeader, wrapped),
          sleep(RUN_TIMEOUT_MS).then(() => {
            throw new Error(`a run hung past ${RUN_TIMEOUT_MS / 1000} s (${board.arm.name}, tap at ${tapAt} ms)`);
          }),
        ]);
        const refused = refuseRun(run, board);
        records.push({ round, arm: board.arm.name, tapAtAsked: tapAt, refused, ...run });
        // Written after every run: a later hang or refusal must not cost the runs already taken.
        writeFileSync(join(outDir, "runs.json"), JSON.stringify(records, null, 2));
        if (refused) throw new Error(`${board.arm.name}, tap at ${tapAt} ms, round ${round}: ${refused}`);
      }
    }

    // Before anything is summarised: a run set whose CPU was never slowed reads as "cannot see it".
    const slowed = boards.map((board) => {
      const runs = records.filter((r) => r.arm === board.arm.name);
      return { hydratedAt: median(runs.map((r) => r.hydratedAt)), loafBlocking: median(runs.map((r) => r.loafBlocking)) };
    });
    for (const [b, board] of boards.entries()) {
      const unslowed = refuseUnslowed({
        cpuRate: args.cpuRate,
        unslowedBlocking: points[b].unslowed.loafBlocking,
        blocking: slowed[b].loafBlocking,
        board: board.arm.name,
      });
      if (unslowed) throw new Error(unslowed);
    }

    summary = buildSummary({
      takenAt: new Date().toISOString(),
      // Where it was measured. No viewer address and no key: this file gets committed.
      target: { baseUrl: args.baseUrl, route: ROUTE, seeded: true },
      instrument: {
        command: "perf:field",
        browser: `Chrome ${browser.version()}`,
        cpuRate: args.cpuRate,
        networkThrottling: "none",
        viewport: VIEWPORT,
        webVitals: `next@${nextVersion} dist/compiled/web-vitals-attribution`,
        settleMs: args.settleMs,
        runsPerCell: args.runs,
        metrics: METRICS.map((m) => m.key),
      },
      boards: boards.map((board, b) => ({
        name: board.arm.name,
        dates: board.arm.dates,
        rows: board.rows,
        elements: points[b].elements,
        // How fast the host is, and the evidence that the slowdown applied: three unslowed loads
        // (soonest hydration, most blocking) beside the medians of this board's slowed runs.
        hydratedAt: { unslowed: points[b].unslowed.hydratedAt, slowed: slowed[b].hydratedAt },
        loafBlocking: { unslowed: points[b].unslowed.loafBlocking, slowed: slowed[b].loafBlocking },
        people: board.plan.people.length,
        posts: board.plan.posts.length,
        matches: board.plan.matches.length,
        availability: board.plan.availability.length,
      })),
      conditions: args.tapAt.map((tapAt) => ({
        tapAt,
        arms: boards.map((board) =>
          summariseRuns(records.filter((r) => r.arm === board.arm.name && r.tapAtAsked === tapAt)),
        ),
      })),
    });
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  } finally {
    // The results are on disk before the close: Playwright can spend minutes deleting Chrome's
    // temporary profile on this machine (test/chrome.ts, #280), and that is not worth a run.
    await Promise.race([browser.close().catch(() => {}), sleep(10_000)]);
  }

  process.stdout.write(`\n${formatReport(summary)}\n\n`);
  process.stdout.write(`Summary and per-run records: ${outDir}\n`);
  if (args.runs < MIN_RUNS) process.exitCode = 1;
}

main().then(
  // An explicit exit: a Chrome that outlived the bounded close above must not hold the process open.
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    process.stderr.write(`\n${e.message}\n`);
    process.exit(1);
  },
);
