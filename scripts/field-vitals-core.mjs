/**
 * perf:field — the half that decides things, with no Docker, no browser and no network in it.
 * Story #215.
 *
 * WHAT QUESTION THIS ANSWERS
 *
 * ADR 002's framework trigger is field data from members' phones, judged against thresholds
 * written before any data exists. The cost that fired the lab condition is hydration, read by
 * Lighthouse as Total Blocking Time, and no phone reports TBT. So before a threshold names a
 * metric, this asks whether any metric a phone CAN report moves when /board's rendered list
 * shrinks. Two boards that differ only in their length are loaded on a slowed CPU, each several
 * times, and a metric is said to see the cost only when the two boards' medians are further apart
 * than the runs of one board are from each other.
 *
 * It does not set a threshold and it does not decide the framework. A metric that cannot tell the
 * two boards apart here cannot fire in the field for this cost, and that is all it says.
 *
 * WHY IT IS NOT `perf:floor`
 *
 * Lighthouse scores a load and never touches the page, so it has no INP at all. This command
 * loads the page in Chrome through `playwright-core`, slows the CPU through the DevTools protocol,
 * taps a real control and reads what the page's own `web-vitals` build reports. The fixture, the
 * viewer and the session come from `perf:floor`'s core, so both commands measure the same board.
 */

import {
  SAILED_DATES,
  adminEmailFor,
  fixturePlan,
  fixtureSql,
  measuredViewer,
  median,
} from "./lighthouse-floor-core.mjs";

/**
 * The two boards. `dates` is the fixture's date count; the page renders `dates - SAILED_DATES`
 * day rows, because the default board hides the dates already sailed (#214). So the arms are 40
 * rows against 10, with every other volume the same (`fixturePlan({ dates })`).
 */
export const ARMS = [
  { name: "45 dates", dates: 45 },
  { name: "15 dates", dates: 15 },
];

/** Below this many runs a spread is not worth comparing a delta with, and nothing is labelled. */
export const MIN_RUNS = 5;

/** Lighthouse's own mobile slowdown, applied here with `Emulation.setCPUThrottlingRate`. */
export const CPU_RATE = 4;

/**
 * When the availability toggle is tapped, in ms after navigation start. Two taps, each its own
 * condition with its own runs:
 *
 * - **450 ms** lands while the page is still hydrating. Measured 2026-11-12 on the owner's machine
 *   at 4x, over 100 runs: the toggle is in the document by 176–240 ms and React has hydrated it at
 *   591–792 ms, on both boards. The tap reached the page within 17 ms of the time asked for.
 * - **4,000 ms** lands long after hydration on both.
 *
 * Both are tuned to that machine at 4x. Each run records where its own tap fell against its own
 * hydration, so a run on a faster or slower host, or at another `--cpu-rate`, says so instead of
 * silently measuring the other condition; pass `--tap-at` to move them (at 8x the same page
 * hydrated at about 1,660 ms).
 */
export const TAP_OFFSETS = [450, 4000];

/** How long after the tap the page is left alone before it is read. The same for every run. */
export const SETTLE_MS = 4000;

/** Lighthouse's mobile preset (Moto G Power), so the page geometry is `perf:floor`'s. */
export const VIEWPORT = { width: 412, height: 823, deviceScaleFactor: 1.75 };

/** Where the page keeps what it measured, one key per document. See `collectInPage` in the runner. */
export const STORE_PREFIX = "__tender_field_vitals:";

/**
 * The metrics a run records, in the order the report prints them. `field` says whether a phone
 * could report the number: every one here can, in a browser that supports the API behind it.
 */
export const METRICS = [
  { key: "lcp", label: "LCP", unit: "ms" },
  { key: "inp", label: "INP", unit: "ms" },
  { key: "inpInputDelay", label: "INP input delay", unit: "ms" },
  { key: "inpProcessingDuration", label: "INP processing", unit: "ms" },
  { key: "inpPresentationDelay", label: "INP presentation delay", unit: "ms" },
  { key: "loafBlocking", label: "LoAF blocking, whole run", unit: "ms" },
  { key: "loafBlockingBeforeTap", label: "LoAF blocking, before the tap", unit: "ms" },
  { key: "fcp", label: "FCP", unit: "ms" },
  { key: "ttfb", label: "TTFB", unit: "ms" },
  { key: "cls", label: "CLS", unit: "" },
];

/**
 * The command line, parsed before anything touches Docker, GoTrue or Chrome, and an unknown flag
 * is refused rather than ignored: a dropped flag is a run measuring something other than what was
 * asked for (`perf:floor`'s rule).
 */
export function parseArgs(argv) {
  const args = {
    stack: "http://127.0.0.1:54321",
    baseUrl: "http://localhost:3100",
    dbContainer: null,
    runs: MIN_RUNS,
    cpuRate: CPU_RATE,
    tapAt: [],
    settleMs: SETTLE_MS,
    out: "field-vitals",
  };
  const number = (flag, raw, ok) => {
    const n = Number(raw);
    if (raw === undefined || raw === "" || !ok(n)) throw new Error(`${flag} cannot be ${JSON.stringify(raw)}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--stack") args.stack = value();
    else if (flag === "--base-url") args.baseUrl = value();
    else if (flag === "--db-container") args.dbContainer = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--runs") args.runs = number(flag, value(), (n) => Number.isInteger(n) && n >= 1);
    else if (flag === "--cpu-rate") args.cpuRate = number(flag, value(), (n) => Number.isFinite(n) && n >= 1);
    else if (flag === "--tap-at") args.tapAt.push(number(flag, value(), (n) => Number.isInteger(n) && n >= 0));
    else if (flag === "--settle") args.settleMs = number(flag, value(), (n) => Number.isInteger(n) && n >= 0);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.dbContainer) throw new Error("--db-container is required: every run reseeds the stack (e.g. supabase_db_stack)");
  if (!args.tapAt.length) args.tapAt = [...TAP_OFFSETS];
  if (new Set(args.tapAt).size !== args.tapAt.length) throw new Error("--tap-at was given the same offset twice");
  return args;
}

/**
 * One arm's board, ready to seed: the plan, who signs in, and the toggle the run taps.
 *
 * The tap is always the FIRST day row's toggle, pressed: the viewer has said they can sail that
 * day and the tap takes it back. That direction is chosen because taking a day back deletes one
 * row and emails nobody, while marking a day re-runs the ladder for every open post on it.
 *
 * The 45-date plan does not mark the viewer for that day, so the row is added here. It goes FIRST
 * in the list on purpose. The board's availability read is capped at 1,000 rows by the API
 * (`max_rows`; measured 2026-11-12 on a local stack: 1,000 of 1,126 returned), the plan carries
 * 1,125, and rows come back in the order they were written. A row added after the seed is the
 * 1,126th and the board never sees it, so the toggle would read unpressed on a day the database
 * says is marked.
 */
export function armBoard(arm, { now = new Date() } = {}) {
  const plan = fixturePlan({ dates: arm.dates, now });
  const viewer = measuredViewer(plan);
  const tapDate = plan.dates[SAILED_DATES];
  const availability = markedWithinCap(plan.availability, viewer.id, tapDate.id);
  return {
    arm,
    plan: { ...plan, availability },
    viewer,
    tapDateId: tapDate.id,
    /** The first day row's toggle. A uuid id cannot be written `li#<uuid>`, hence the attribute form. */
    tapSelector: `li[id="${tapDate.id}"] form button`,
    rows: arm.dates - SAILED_DATES,
    addedAvailability: availability.length - plan.availability.length,
  };
}

/** How many rows one API read returns: PostgREST's `max_rows`, 1,000 on a local stack and by default on a hosted project. */
export const API_ROW_CAP = 1000;

/**
 * The availability rows with `personId` marked for `raceDateId` somewhere the board will read it.
 * A missing row is added FIRST; a row already there is left where it is, and refused if that is
 * past the cap, since the page would then show the day unmarked whatever the database says.
 *
 * @param {{ personId: string, raceDateId: string }[]} availability
 * @param {string} personId
 * @param {string} raceDateId
 * @returns {{ personId: string, raceDateId: string }[]}
 */
export function markedWithinCap(availability, personId, raceDateId) {
  const at = availability.findIndex((a) => a.personId === personId && a.raceDateId === raceDateId);
  if (at === -1) return [{ personId, raceDateId }, ...availability];
  if (at >= API_ROW_CAP) {
    throw new Error(`the viewer's row for the tapped day is row ${at + 1}, past the API's ${API_ROW_CAP}-row cap, so the board would not show it`);
  }
  return availability;
}

/**
 * The reseed every run starts from. `truncate … cascade`, not `delete`: the cap above makes the
 * ORDER rows were written in part of what the board renders, and only an empty heap gives the
 * same order every time. It empties `race_date` and every table that hangs off it (posts,
 * availability, matches, answers, suggestions, messages, the notification log), which is why
 * the runner refuses any Supabase that is not loopback before this is sent.
 */
export function seedSql(board) {
  return `truncate table public.race_date cascade;\n${fixtureSql(board.plan, { adminEmail: adminEmailFor(board.plan) })}`;
}

/** Where Next keeps its attribution build. Named once, so the runner and the test read the same file. */
export const WEB_VITALS_BUILD = "next/dist/compiled/web-vitals-attribution/web-vitals.attribution.js";

/**
 * Next's own copy of the `web-vitals` attribution build, wrapped so a browser can run it.
 *
 * The file is `WEB_VITALS_BUILD`, the build
 * `useReportWebVitals` loads when `experimental.webVitalsAttribution` is set. tender has no
 * reporter yet, so the runner injects that file instead of adding one to the app (owner decision
 * at pickup, 2026-11-12): the measured page is the page members get. It is a CommonJS bundle that
 * reads `module` and `__dirname`, which a page has neither of.
 *
 * One difference from a real reporter, and it flatters the metrics if anything: this listens from
 * the first byte, while a reporter mounted by React starts after hydration and sees earlier
 * entries only through the browser's buffer.
 */
export function wrapWebVitals(source) {
  if (!source.includes("module.exports")) throw new Error("the web-vitals build is not the CommonJS bundle this wrapper expects");
  return `(function(){var module={exports:{}};var __dirname="";${source}\n;window.__tenderWebVitals=module.exports;})();`;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One run, from what the page stored. `store` maps a key per document to that document's record;
 * the FIRST document is the measured load. A second one means the tap was a plain form post that
 * replaced the page, which is what a tap does before React has hydrated the form.
 *
 * @param {{ store: Record<string, any>, pressedAfter: string | null, rowsAfter: number | null, markedAfter: boolean | null }} raw
 */
export function readRun({ store, pressedAfter = null, rowsAfter = null, markedAfter = null }) {
  const docs = Object.values(store ?? {}).sort((a, b) => a.timeOrigin - b.timeOrigin);
  if (!docs.length) throw new Error("the page stored nothing: the collector did not run");
  const first = docs[0];
  const m = first.metrics ?? {};
  const inp = m.INP ?? null;
  const tapAt = num(inp?.interactionTime);
  const loaf = first.loaf ?? [];
  const phases = inp
    ? [
        ["input delay", num(inp.inputDelay)],
        ["processing", num(inp.processingDuration)],
        ["presentation delay", num(inp.presentationDelay)],
      ]
    : [];
  const largest = phases.filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
  const hydratedAt = num(first.hydratedAt);
  return {
    documents: docs.length,
    lcp: num(m.LCP?.value),
    lcpTarget: m.LCP?.target ?? null,
    fcp: num(m.FCP?.value),
    ttfb: num(m.TTFB?.value),
    cls: num(m.CLS?.value),
    inp: num(inp?.value),
    inpInputDelay: num(inp?.inputDelay),
    inpProcessingDuration: num(inp?.processingDuration),
    inpPresentationDelay: num(inp?.presentationDelay),
    /** The largest of the three phases: where the interaction's time went. */
    inpPhase: largest ? largest[0] : null,
    inpTarget: inp?.interactionTarget ?? null,
    inpLoadState: inp?.loadState ?? null,
    /** When the tap actually reached the page, from the interaction's own timestamp. */
    tapAt,
    loafSupported: first.loafSupported === true,
    loafCount: first.loafSupported === true ? loaf.length : null,
    loafBlocking: first.loafSupported === true ? sum(loaf.map((e) => e.blockingDuration)) : null,
    loafBlockingBeforeTap:
      first.loafSupported === true && tapAt != null
        ? sum(loaf.filter((e) => e.startTime < tapAt).map((e) => e.blockingDuration))
        : null,
    targetAt: num(first.targetAt),
    hydratedAt,
    /** Where the tap fell against THIS run's hydration. A document replaced before it hydrated is "before". */
    tapPhase: tapAt == null ? null : hydratedAt == null || tapAt < hydratedAt ? "before hydration" : "after hydration",
    /** What the tap did to the page. */
    outcome:
      pressedAfter !== "false" && markedAfter !== false
        ? "no effect"
        : docs.length > 1
          ? "document navigation"
          : "client transition",
    pressedAfter,
    markedAfter,
    rowsAfter,
  };
}

/**
 * Why a run cannot be counted, or null. A run that measured some other page, or whose tap never
 * became an interaction on the toggle, would otherwise add a plausible number to a median.
 */
export function refuseRun(run, board) {
  if (run.rowsAfter !== board.rows) return `the board rendered ${run.rowsAfter} day rows, not the ${board.rows} this arm seeds`;
  if (run.lcp == null) return "the page reported no LCP";
  if (run.inp == null) return "the tap produced no interaction: the page reported no INP";
  // A target that was reported has to be the toggle. A target that was NOT reported is left to
  // the next check: `web-vitals` names the element only if it is still in the document when it
  // looks, and the tap's own re-render can replace the button first (measured at 8x, 1 run in 6;
  // never in 80 runs at 4x). The day being taken back is then the proof of where the tap landed.
  if (run.inpTarget != null && (!String(run.inpTarget).includes(board.tapDateId) || !/button$/.test(String(run.inpTarget)))) {
    return `the tap landed on ${JSON.stringify(run.inpTarget)}, not on the first day's toggle`;
  }
  if (run.outcome === "no effect") return "the tap did not take the day back: the toggle and the database both still say marked";
  return null;
}

/** Slowed runs must show more than this many times the long-frame blocking of the unslowed loads. */
export const SLOWDOWN_PROOF = 1.5;

/** How many unslowed loads each board's reference is taken from. */
export const UNSLOWED_LOADS = 3;

/**
 * What a board's unslowed loads say, as one reference: the soonest it hydrated, and the MOST
 * long-frame blocking any of them showed. The first is a reading of the host. The second is the
 * bar the slowed runs must clear, so the least flattering load sets it.
 *
 * Hydration time is deliberately not that bar. Measured 2026-11-12: unslowed loads of one board
 * hydrate at about 170 ms or about 420 ms, in two groups, and all three loads landed in the slow
 * group twice in five tries. Against 420 ms a sound 4x run set (about 650 ms) barely clears any
 * useful factor. Long-frame blocking read 0 ms on every unslowed load in both groups.
 */
export function unslowedReference(loads) {
  const numbers = (key) => loads.map((l) => l[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
  const hydrated = numbers("hydratedAt");
  const blocking = numbers("loafBlocking");
  return {
    hydratedAt: hydrated.length ? Math.min(...hydrated) : null,
    // Every load must have reported it: a load with no reading could be the one that blocked most.
    loafBlocking: blocking.length === loads.length && blocking.length ? Math.max(...blocking) : null,
  };
}

/**
 * Was the CPU really slowed? Returns a refusal or null.
 *
 * If the slowdown silently failed to apply, every number would be small, the two boards would sit
 * inside each other's spread, and the command would report "cannot see it" for a cost it never
 * created. So each board is also loaded unslowed, and the slowed runs' long frames must block for
 * clearly longer than those loads' did. Measured 2026-11-12 on the 40-row board: 0 ms unslowed,
 * 216 ms at 4x, 635 ms at 8x. Where the unslowed loads show none at all, as on that machine, any
 * blocking in the slowed runs is the proof and none is the refusal.
 */
export function refuseUnslowed({ cpuRate, unslowedBlocking, blocking, board }) {
  if (cpuRate < 2) return null;
  if (unslowedBlocking == null || blocking == null) {
    return `${board}: long animation frames were not reported, so nothing shows the ${cpuRate}x CPU slowdown was applied`;
  }
  if (blocking <= SLOWDOWN_PROOF * unslowedBlocking) {
    return `${board}: long frames blocked for ${Math.round(blocking)} ms slowed and ${Math.round(unslowedBlocking)} ms unslowed, so the ${cpuRate}x CPU slowdown does not appear to have been applied`;
  }
  return null;
}

/** Largest minus smallest: how far apart the runs of one arm are. Null when nothing was reported. */
export function spread(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return xs.length ? Math.max(...xs) - Math.min(...xs) : null;
}

/**
 * One arm's runs under one tap offset, per metric: every value kept beside its median and spread.
 *
 * @param {Record<string, any>[]} runs
 */
export function summariseRuns(runs) {
  /** @type {Record<string, { median: number | null, spread: number | null, values: (number | null)[] }>} */
  const metrics = {};
  for (const { key } of METRICS) {
    const values = runs.map((r) => r[key] ?? null);
    metrics[key] = { median: median(values), spread: spread(values), values };
  }
  const tally = (key) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const r of runs) out[r[key] ?? "none"] = (out[r[key] ?? "none"] ?? 0) + 1;
    return out;
  };
  return {
    runs: runs.length,
    metrics,
    tapAt: { median: median(runs.map((r) => r.tapAt)), values: runs.map((r) => r.tapAt) },
    hydratedAt: { median: median(runs.map((r) => r.hydratedAt)), values: runs.map((r) => r.hydratedAt) },
    tapPhase: tally("tapPhase"),
    outcome: tally("outcome"),
    inpPhase: tally("inpPhase"),
    inpLoadState: tally("inpLoadState"),
  };
}

/**
 * Does a metric see the cost? The rule is #215 AC 4's, read the strict way.
 *
 * `delta` is the larger board's median minus the smaller board's. `threshold` is the larger of
 * the two boards' run-to-run spreads: the AC says "the larger arm's spread", which could mean the
 * 45-date arm's, and the larger of the two is never below that, so a metric that passes here
 * passes under either reading. Both spreads are kept so the other reading can be checked by eye.
 *
 * A metric SEES the cost only when the delta is above that threshold. A delta the wrong way
 * round, however large, is not the cost being seen.
 *
 * @returns {{ delta: number | null, threshold: number | null, spreads: (number | null)[],
 *             sees: boolean | null, label: string }}
 */
export function labelMetric(larger, smaller, { minRuns = MIN_RUNS } = {}) {
  const spreads = [larger.spread, smaller.spread];
  const counted = (s) => s.values.filter((v) => typeof v === "number" && Number.isFinite(v)).length;
  if (larger.median == null || smaller.median == null) {
    return { delta: null, threshold: null, spreads, sees: false, label: "cannot see it: not reported by this browser" };
  }
  const delta = larger.median - smaller.median;
  const threshold = Math.max(...spreads);
  if (Math.min(counted(larger), counted(smaller)) < minRuns) {
    return { delta, threshold, spreads, sees: null, label: `not labelled: fewer than ${minRuns} runs` };
  }
  const sees = delta > threshold;
  return { delta, threshold, spreads, sees, label: sees ? "sees the cost" : "cannot see it" };
}

/**
 * The whole finding as data. `conditions` is one entry per tap offset, each holding both arms'
 * summaries (in `ARMS` order: larger board first) and a label per metric.
 *
 * `finding.none` is #215 AC 7: true only when every metric under every tap offset was labelled
 * and none saw the cost. It is false when anything saw it, and null when a label is missing (a
 * short run), because "nothing saw it" must not be reachable by measuring too little.
 */
export function buildSummary({ takenAt, target, instrument, boards, conditions, minRuns = MIN_RUNS }) {
  const out = [];
  for (const c of conditions) {
    const [larger, smaller] = c.arms;
    /** @type {Record<string, ReturnType<typeof labelMetric>>} */
    const labels = {};
    for (const { key } of METRICS) labels[key] = labelMetric(larger.metrics[key], smaller.metrics[key], { minRuns });
    out.push({ tapAt: c.tapAt, arms: c.arms, labels });
  }
  const all = out.flatMap((c) => METRICS.map(({ key, label }) => ({ tapAt: c.tapAt, metric: key, label, verdict: c.labels[key] })));
  const seen = all
    .filter((l) => l.verdict.sees === true)
    .map(({ tapAt, metric, label, verdict }) => ({ tapAt, metric, label, delta: verdict.delta, threshold: verdict.threshold }));
  const unlabelled = all.some((l) => l.verdict.sees === null);
  return {
    takenAt,
    target,
    instrument,
    boards,
    rule: "a metric sees the cost only if (larger board's median - smaller board's median) > the larger of the two boards' run-to-run spreads (max - min)",
    conditions: out,
    finding: { seen, none: seen.length ? false : unlabelled ? null : true },
  };
}

const fmt = (v, unit) => (v == null ? "n/a" : unit === "" ? v.toFixed(3) : String(Math.round(v)));

/** The run as a person reads it: every value beside its median, the two boards side by side. */
export function formatReport(summary) {
  const out = [];
  const [a, b] = summary.boards;
  out.push(`/board at ${summary.instrument.cpuRate}x CPU, ${a.dates} dates (${a.rows} rows) against ${b.dates} dates (${b.rows} rows)`);
  for (const c of summary.conditions) {
    const [larger, smaller] = c.arms;
    out.push("");
    out.push(`Tap at ${c.tapAt} ms  (${larger.runs} + ${smaller.runs} runs)`);
    for (const [arm, board] of [[larger, a], [smaller, b]]) {
      const phases = Object.entries(arm.tapPhase).map(([k, n]) => `${n} ${k}`).join(", ");
      const outcomes = Object.entries(arm.outcome).map(([k, n]) => `${n} ${k}`).join(", ");
      out.push(`  ${board.dates} dates: tap reached the page at ${fmt(arm.tapAt.median, "ms")} ms, hydrated at ${fmt(arm.hydratedAt.median, "ms")} ms; ${phases}; ${outcomes}`);
    }
    for (const { key, label, unit } of METRICS) {
      const l = c.labels[key];
      const row = (arm) => `${fmt(arm.metrics[key].median, unit).padStart(6)} [${arm.metrics[key].values.map((v) => fmt(v, unit)).join(" ")}]`;
      out.push(`  ${label.padEnd(30)} ${row(larger)}  vs ${row(smaller)}`);
      out.push(`  ${"".padEnd(30)} delta ${fmt(l.delta, unit)}, spread ${fmt(l.threshold, unit)}: ${l.label}`);
    }
  }
  out.push("");
  if (summary.finding.none === true) {
    out.push("NO METRIC SAW THE COST. No field threshold can be written against these metrics for it;");
    out.push("the thresholds question goes back to the owner (see docs/performance-floor.md).");
  } else if (summary.finding.none === null) {
    out.push(`NOT A FINDING: fewer than ${MIN_RUNS} runs, so nothing is labelled.`);
  } else {
    out.push("Saw the cost:");
    for (const s of summary.finding.seen) {
      const unit = METRICS.find((m) => m.key === s.metric)?.unit;
      out.push(`  ${s.label} with the tap at ${s.tapAt} ms (delta ${fmt(s.delta, unit)}, spread ${fmt(s.threshold, unit)})`);
    }
  }
  return out.join("\n");
}
