import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  API_ROW_CAP,
  ARMS,
  CPU_RATE,
  METRICS,
  MIN_RUNS,
  SLOWDOWN_PROOF,
  STORE_PREFIX,
  TAP_OFFSETS,
  UNSLOWED_LOADS,
  WEB_VITALS_BUILD,
  armBoard,
  buildSummary,
  formatReport,
  labelMetric,
  markedWithinCap,
  parseArgs,
  readRun,
  refuseRun,
  refuseUnslowed,
  seedSql,
  spread,
  summariseRuns,
  unslowedReference,
  wrapWebVitals,
} from "../scripts/field-vitals-core.mjs";
import { SAILED_DATES } from "../scripts/lighthouse-floor-core.mjs";

/**
 * The half of `perf:field` that can be tested without Docker, Chrome or a network (story #215).
 *
 * What these tests are FOR: the command's whole output is a sentence per metric, "sees the cost"
 * or "cannot see it", and ADR 002's field thresholds will be written against those sentences. So
 * the rule that produces them is held here from both sides, and so is everything that could make
 * a run count when it measured something else: the wrong board, a tap that missed the toggle, a
 * tap that did nothing, a metric the browser never reported.
 */

const now = new Date("2026-11-12T12:00:00Z");
const [bigArm, smallArm] = ARMS;
const big = armBoard(bigArm, { now });
const small = armBoard(smallArm, { now });

describe("the two boards (#215)", () => {
  it("are 45 dates and 15, which the default board renders as 40 rows and 10", () => {
    expect(ARMS.map((a) => a.dates)).toEqual([45, 15]);
    expect([big.rows, small.rows]).toEqual([40, 10]);
    expect(big.plan.dates).toHaveLength(45);
    expect(small.plan.dates).toHaveLength(15);
  });

  it("sign the same person in on both, and tap the same day", () => {
    expect(small.viewer).toEqual(big.viewer);
    expect(small.tapDateId).toBe(big.tapDateId);
    expect(big.tapDateId).toBe(big.plan.dates[SAILED_DATES].id);
    expect(big.tapSelector).toBe(`li[id="${big.tapDateId}"] form button`);
    // The tapped day is the first one still to sail, so its row is the first on the page.
    expect(new Date(big.plan.dates[SAILED_DATES].startsAt).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(big.plan.dates[SAILED_DATES - 1].startsAt).getTime()).toBeLessThan(now.getTime());
  });

  it("have the viewer marked for the tapped day, so the tap takes it back on both", () => {
    for (const board of [big, small]) {
      const rows = board.plan.availability.filter((a) => a.personId === board.viewer.id && a.raceDateId === board.tapDateId);
      expect(rows).toHaveLength(1);
    }
    // The 45-date plan does not mark the viewer for that day; the 15-date plan already does.
    expect(big.addedAvailability).toBe(1);
    expect(big.plan.availability).toHaveLength(1126);
    expect(small.addedAvailability).toBe(0);
    expect(small.plan.availability).toHaveLength(1125);
  });

  // The board's read stops at 1,000 rows, in the order they were written. A row appended to the
  // plan would be the 1,126th: in the database, never on the page.
  it("put an added row first, where the capped read still returns it", () => {
    expect(big.plan.availability[0]).toEqual({ personId: big.viewer.id, raceDateId: big.tapDateId });
    const at = small.plan.availability.findIndex((a) => a.personId === small.viewer.id && a.raceDateId === small.tapDateId);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(API_ROW_CAP);
  });
});

describe("markedWithinCap", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ personId: `p${i}`, raceDateId: "d" }));

  it("adds a missing row at the front and nothing else", () => {
    const rows = filler(3);
    expect(markedWithinCap(rows, "me", "d")).toEqual([{ personId: "me", raceDateId: "d" }, ...rows]);
  });

  it("leaves a row that is already inside the cap where it is", () => {
    const rows = [...filler(API_ROW_CAP - 1), { personId: "me", raceDateId: "d" }];
    expect(markedWithinCap(rows, "me", "d")).toBe(rows);
  });

  it("refuses a row that sits just past the cap", () => {
    const rows = [...filler(API_ROW_CAP), { personId: "me", raceDateId: "d" }];
    expect(() => markedWithinCap(rows, "me", "d")).toThrow(/row 1001, past the API's 1000-row cap/);
  });
});

describe("seedSql", () => {
  const sql = seedSql(big);

  it("empties the race dates and what hangs off them before the seed's own transaction", () => {
    expect(sql.startsWith("truncate table public.race_date cascade;\nbegin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.match(/\btruncate\b/g)).toHaveLength(1);
  });

  it("writes the viewer's row for the tapped day before any other availability row", () => {
    const inserts = sql.split("\n").filter((l) => l.startsWith("insert into public.availability"));
    expect(inserts).toHaveLength(1126);
    expect(inserts[0]).toContain(`'${big.viewer.id}', '${big.tapDateId}'`);
  });

  it("seeds 15 race dates for the smaller board", () => {
    const dates = seedSql(small).split("\n").filter((l) => l.startsWith("insert into public.race_date"));
    expect(dates).toHaveLength(15);
  });
});

describe("wrapWebVitals", () => {
  const require = createRequire(import.meta.url);
  // The path is the runner's own constant: a test with its own copy would go on reading the
  // attribution build after the runner had been pointed at some other file.
  const source = readFileSync(require.resolve(WEB_VITALS_BUILD), "utf8");

  // The real file out of node_modules, run the way the page runs it. If a Next upgrade moves the
  // file, changes its module format or drops a metric, this is where it shows, not as a run
  // that reports nothing.
  it("turns Next's attribution build into a page script that exposes the five reporters", () => {
    const window: Record<string, unknown> = {};
    const context = vm.createContext({ window, self: window, document: {}, performance: { now: () => 0 }, addEventListener() {} });
    vm.runInContext(wrapWebVitals(source), context);
    const vitals = window.__tenderWebVitals as Record<string, unknown>;
    for (const on of ["onLCP", "onINP", "onCLS", "onFCP", "onTTFB"]) expect(typeof vitals[on]).toBe("function");
  });

  it("is the ATTRIBUTION build, the one that breaks INP into its phases", () => {
    for (const field of ["inputDelay", "processingDuration", "presentationDelay", "interactionTarget", "longAnimationFrameEntries"]) {
      expect(source).toContain(field);
    }
  });

  it("refuses a file that is not the CommonJS bundle it knows how to wrap", () => {
    expect(() => wrapWebVitals("export const onINP = () => {};")).toThrow(/not the CommonJS bundle/);
  });
});

/** One document's record, as the in-page collector stores it. */
function doc({
  timeOrigin = 1000,
  lcp = 640,
  inp = { value: 344, interactionTime: 460, inputDelay: 323, processingDuration: 16, presentationDelay: 5 } as Record<string, unknown> | null,
  loaf = [
    { startTime: 130, duration: 74, blockingDuration: 22 },
    { startTime: 240, duration: 170, blockingDuration: 105 },
    { startTime: 470, duration: 300, blockingDuration: 250 },
  ],
  loafSupported = true,
  hydratedAt = 800 as number | null,
} = {}) {
  return {
    timeOrigin,
    url: "http://localhost:3100/board",
    metrics: {
      LCP: { value: lcp, target: "#row>span" },
      FCP: { value: 216 },
      TTFB: { value: 50 },
      CLS: { value: 0 },
      ...(inp ? { INP: { interactionTarget: `#${big.tapDateId}>form>button`, loadState: "loading", ...inp } } : {}),
    },
    loaf,
    loafSupported,
    targetAt: 227,
    hydratedAt,
  };
}

const page = (docs: ReturnType<typeof doc>[], rest: Record<string, unknown> = {}) => ({
  store: Object.fromEntries(docs.map((d, i) => [`${STORE_PREFIX}${i}`, d])),
  pressedAfter: "false",
  rowsAfter: 40,
  markedAfter: false,
  ...rest,
});

describe("readRun", () => {
  it("reads LCP, INP with its three phases, and the long-animation-frame blocking time", () => {
    const run = readRun(page([doc()]));
    expect(run).toMatchObject({
      lcp: 640,
      inp: 344,
      inpInputDelay: 323,
      inpProcessingDuration: 16,
      inpPresentationDelay: 5,
      inpPhase: "input delay",
      inpLoadState: "loading",
      tapAt: 460,
      loafCount: 3,
      loafBlocking: 377,
      fcp: 216,
      ttfb: 50,
      cls: 0,
    });
  });

  it("counts only the frames that began before the tap as blocking before the tap", () => {
    expect(readRun(page([doc()])).loafBlockingBeforeTap).toBe(127);
  });

  it("names the largest phase, whichever it is", () => {
    const inp = { value: 90, interactionTime: 4000, inputDelay: 10, processingDuration: 60, presentationDelay: 20 };
    expect(readRun(page([doc({ inp })])).inpPhase).toBe("processing");
    expect(readRun(page([doc({ inp: { ...inp, processingDuration: 5 } })])).inpPhase).toBe("presentation delay");
  });

  it("says where the tap fell against this run's own hydration", () => {
    expect(readRun(page([doc({ hydratedAt: 800 })])).tapPhase).toBe("before hydration");
    expect(readRun(page([doc({ hydratedAt: 300 })])).tapPhase).toBe("after hydration");
    // A document the tap replaced before React reached the toggle never hydrated it at all.
    expect(readRun(page([doc({ hydratedAt: null })])).tapPhase).toBe("before hydration");
    expect(readRun(page([doc({ inp: null })])).tapPhase).toBeNull();
  });

  it("reports null, not zero, where the browser has no long animation frames", () => {
    const run = readRun(page([doc({ loafSupported: false, loaf: [] })]));
    expect(run.loafSupported).toBe(false);
    expect(run.loafBlocking).toBeNull();
    expect(run.loafBlockingBeforeTap).toBeNull();
    expect(run.loafCount).toBeNull();
  });

  // The measured load is the FIRST document. When the tap is a plain form post, the page that
  // comes back is a second document with its own LCP and no interaction, stored under a later key.
  it("reads the first document when the tap replaced the page, and says it did", () => {
    const second = doc({ timeOrigin: 2000, lcp: 111, inp: null });
    const run = readRun(page([second, doc({ timeOrigin: 1000 })]));
    expect(run.documents).toBe(2);
    expect(run.lcp).toBe(640);
    expect(run.outcome).toBe("document navigation");
  });

  it("tells a client transition from a tap that did nothing", () => {
    expect(readRun(page([doc()])).outcome).toBe("client transition");
    expect(readRun(page([doc()], { pressedAfter: "true", markedAfter: true })).outcome).toBe("no effect");
  });

  it("refuses a page that stored nothing", () => {
    expect(() => readRun({ store: {}, pressedAfter: null, rowsAfter: 0, markedAfter: null })).toThrow(/stored nothing/);
  });
});

describe("refuseRun", () => {
  const good = readRun(page([doc()]));

  it("counts a run that measured this board and tapped its toggle", () => {
    expect(refuseRun(good, big)).toBeNull();
  });

  it("refuses a run of the other board", () => {
    expect(refuseRun(good, small)).toMatch(/rendered 40 day rows, not the 10/);
  });

  it("refuses a run with no LCP or no interaction", () => {
    expect(refuseRun({ ...good, lcp: null }, big)).toMatch(/no LCP/);
    expect(refuseRun(readRun(page([doc({ inp: null })])), big)).toMatch(/no INP/);
  });

  it("refuses a tap that landed anywhere but the first day's toggle", () => {
    expect(refuseRun({ ...good, inpTarget: "html>body>div#main>main>h1" }, big)).toMatch(/not on the first day's toggle/);
    // The right row but the wrong element in it.
    expect(refuseRun({ ...good, inpTarget: `#${big.tapDateId}>span` }, big)).toMatch(/not on the first day's toggle/);
    // The right element in another day's row.
    expect(refuseRun({ ...good, inpTarget: `#${big.plan.dates[SAILED_DATES + 1].id}>form>button` }, big)).toMatch(/not on the first day's toggle/);
  });

  it("refuses a tap that changed nothing", () => {
    const idle = readRun(page([doc()], { pressedAfter: "true", markedAfter: true }));
    expect(refuseRun(idle, big)).toMatch(/did not take the day back/);
  });

  // The library names the tapped element only if it is still in the document when it looks, and
  // the tap's own re-render can replace the button first. Seen at 8x: a tap that did its job,
  // with no target. The day being taken back is then what shows where the tap landed.
  it("counts a run whose target was not reported when the tap did take the day back", () => {
    expect(refuseRun({ ...good, inpTarget: null }, big)).toBeNull();
  });

  it("still refuses a run with no reported target when the tap changed nothing", () => {
    const idle = readRun(page([doc()], { pressedAfter: "true", markedAfter: true }));
    expect(refuseRun({ ...idle, inpTarget: null }, big)).toMatch(/did not take the day back/);
  });
});

// If the slowdown silently failed, both boards would be fast, sit inside each other's spread, and
// the command would report "cannot see it" for a cost it never created.
describe("refuseUnslowed", () => {
  const at = (blocking: number | null, unslowedBlocking: number | null = 0, cpuRate = 4) =>
    refuseUnslowed({ cpuRate, unslowedBlocking, blocking, board: "45 dates" });

  it("accepts runs whose long frames blocked clearly longer than the unslowed loads' did", () => {
    expect(at(216)).toBeNull();
    // On a host whose unslowed loads already block, the slowed runs have to clear 1.5 times that.
    expect(SLOWDOWN_PROOF).toBe(1.5);
    expect(at(151, 100)).toBeNull();
  });

  it("refuses runs that blocked about as long as the unslowed loads", () => {
    expect(at(150, 100)).toMatch(/long frames blocked for 150 ms slowed and 100 ms unslowed, so the 4x CPU slowdown does not appear to have been applied/);
    expect(at(100, 100)).toMatch(/does not appear to have been applied/);
  });

  // The case on the owner's machine: no long frame at all unslowed, so none slowed is the tell.
  it("refuses slowed runs with no blocking at all when the unslowed loads had none either", () => {
    expect(at(0, 0)).toMatch(/blocked for 0 ms slowed and 0 ms unslowed/);
    expect(at(1, 0)).toBeNull();
  });

  it("refuses when long frames were not reported on either side", () => {
    expect(at(null)).toMatch(/45 dates: long animation frames were not reported/);
    expect(at(216, null)).toMatch(/long animation frames were not reported/);
  });

  it("asks for no proof when no slowdown was asked for", () => {
    expect(at(0, 0, 1)).toBeNull();
  });
});

describe("unslowedReference", () => {
  // Unslowed loads of one board hydrate at about 170 ms or about 420 ms. The soonest is the
  // host's speed; the most blocking is the bar the slowed runs must clear.
  it("is the soonest hydration and the most blocking of the three loads", () => {
    expect(UNSLOWED_LOADS).toBe(3);
    const loads = [
      { hydratedAt: 425, loafBlocking: 0 },
      { hydratedAt: 170, loafBlocking: 12 },
      { hydratedAt: 433, loafBlocking: 3 },
    ];
    expect(unslowedReference(loads)).toEqual({ hydratedAt: 170, loafBlocking: 12 });
  });

  it("skips a load that never hydrated instead of reading it as the soonest", () => {
    const loads = [
      { hydratedAt: null, loafBlocking: 0 },
      { hydratedAt: 170, loafBlocking: 0 },
    ];
    expect(unslowedReference(loads).hydratedAt).toBe(170);
    expect(unslowedReference([{ hydratedAt: null, loafBlocking: 0 }]).hydratedAt).toBeNull();
  });

  // A load with no reading could be the one that blocked most, so the bar is unknown.
  it("has no blocking reference unless every load reported one", () => {
    const loads = [
      { hydratedAt: 170, loafBlocking: 0 },
      { hydratedAt: 180, loafBlocking: null },
    ];
    expect(unslowedReference(loads).loafBlocking).toBeNull();
    expect(unslowedReference([]).loafBlocking).toBeNull();
  });
});

const stats = (values: (number | null)[]) => summariseRuns(values.map((v) => ({ inp: v }))).metrics.inp;

describe("spread and summariseRuns", () => {
  it("is the largest run minus the smallest, with every value kept", () => {
    expect(spread([344, 300, 410, 352, 361])).toBe(110);
    expect(stats([344, 300, 410, 352, 361])).toEqual({ median: 352, spread: 110, values: [344, 300, 410, 352, 361] });
  });

  it("is null when nothing was reported, and ignores a missing run", () => {
    expect(spread([null, null])).toBeNull();
    expect(spread([10, null, 30])).toBe(20);
  });

  it("tallies where the taps fell and what they did", () => {
    const runs = [readRun(page([doc()])), readRun(page([doc({ hydratedAt: 300 })])), readRun(page([doc()]))];
    const s = summariseRuns(runs);
    expect(s.runs).toBe(3);
    expect(s.tapPhase).toEqual({ "before hydration": 2, "after hydration": 1 });
    expect(s.outcome).toEqual({ "client transition": 3 });
    expect(s.inpPhase).toEqual({ "input delay": 3 });
    expect(s.metrics.lcp.values).toEqual([640, 640, 640]);
  });
});

describe("labelMetric — #215 AC 4's rule", () => {
  it("says a metric sees the cost when the medians are further apart than either board's runs", () => {
    const l = labelMetric(stats([340, 350, 360, 345, 355]), stats([250, 262, 258, 255, 260]));
    expect(l).toMatchObject({ delta: 92, threshold: 20, spreads: [20, 12], sees: true, label: "sees the cost" });
  });

  it("does not, when the delta only equals the spread", () => {
    const l = labelMetric(stats([340, 350, 360, 345, 355]), stats([330, 330, 330, 330, 330]));
    expect(l).toMatchObject({ delta: 20, threshold: 20, sees: false, label: "cannot see it" });
  });

  // The larger of the two spreads decides, whichever board it belongs to. Here the 45-date
  // board's own runs are tight (10) and the 15-date board's are not (120).
  it("uses the wider board's spread even when that is the smaller board", () => {
    const l = labelMetric(stats([400, 405, 410, 402, 408]), stats([300, 420, 310, 330, 340]));
    expect(l).toMatchObject({ delta: 75, threshold: 120, spreads: [10, 120], sees: false });
  });

  it("does not count a difference the wrong way round, however large", () => {
    const l = labelMetric(stats([100, 101, 102, 103, 104]), stats([300, 301, 302, 303, 304]));
    expect(l).toMatchObject({ delta: -200, threshold: 4, sees: false, label: "cannot see it" });
  });

  it("labels nothing from fewer than five runs of either board", () => {
    const l = labelMetric(stats([340, 350, 360, 345]), stats([250, 262, 258, 255, 260]));
    expect(l.sees).toBeNull();
    expect(l.label).toBe("not labelled: fewer than 5 runs");
    expect(MIN_RUNS).toBe(5);
    // A run that reported nothing is not a run of that metric.
    expect(labelMetric(stats([340, 350, 360, 345, null]), stats([250, 262, 258, 255, 260])).sees).toBeNull();
  });

  it("labels a metric the browser never reported as unable to see it", () => {
    const l = labelMetric(stats([null, null, null, null, null]), stats([null, null, null, null, null]));
    expect(l).toMatchObject({ delta: null, sees: false, label: "cannot see it: not reported by this browser" });
  });
});

/** Five runs of one board at one tap offset, every metric flat except the ones named. */
function arm(overrides: Record<string, number[]> = {}) {
  const runs = Array.from({ length: 5 }, (_, i) => {
    const run: Record<string, unknown> = { tapAt: 460, hydratedAt: 800, tapPhase: "before hydration", outcome: "client transition", inpPhase: "input delay", inpLoadState: "loading" };
    for (const { key } of METRICS) run[key] = overrides[key]?.[i] ?? 100;
    return run;
  });
  return summariseRuns(runs);
}

const summary = (conditions: { tapAt: number; arms: ReturnType<typeof arm>[] }[]) =>
  buildSummary({
    takenAt: "2026-11-12T00:00:00.000Z",
    target: { baseUrl: "http://localhost:3100", route: "/board", seeded: true },
    instrument: { cpuRate: CPU_RATE },
    boards: [
      { name: "45 dates", dates: 45, rows: 40 },
      { name: "15 dates", dates: 15, rows: 10 },
    ],
    conditions,
  });

describe("buildSummary and the finding (#215 AC 7)", () => {
  const flat = { tapAt: 4000, arms: [arm(), arm()] };
  const moved = { tapAt: 450, arms: [arm({ inp: [340, 350, 360, 345, 355] }), arm({ inp: [250, 262, 258, 255, 260] })] };

  it("labels every metric under every tap offset", () => {
    const s = summary([moved, flat]);
    expect(s.conditions.map((c) => c.tapAt)).toEqual([450, 4000]);
    for (const c of s.conditions) expect(Object.keys(c.labels)).toEqual(METRICS.map((m) => m.key));
    expect(s.conditions[0].labels.inp.label).toBe("sees the cost");
    expect(s.conditions[1].labels.inp.label).toBe("cannot see it");
  });

  it("lists what saw the cost, and under which tap", () => {
    const s = summary([moved, flat]);
    expect(s.finding.none).toBe(false);
    expect(s.finding.seen).toEqual([{ tapAt: 450, metric: "inp", label: "INP", delta: 92, threshold: 20 }]);
  });

  it("says so plainly when no metric saw it", () => {
    const s = summary([flat, { ...flat, tapAt: 450 }]);
    expect(s.finding).toEqual({ seen: [], none: true });
    const report = formatReport(s);
    expect(report).toContain("NO METRIC SAW THE COST");
    expect(report).toContain("the thresholds question goes back to the owner");
    expect(report).not.toContain("Saw the cost:");
  });

  // "Nothing saw it" must not be reachable by measuring too little.
  it("is not a finding at all from a short run", () => {
    const shortArm = () => summariseRuns([{ lcp: 100, inp: 100 }]);
    const s = summary([{ tapAt: 450, arms: [shortArm(), shortArm()] }]);
    expect(s.finding.none).toBeNull();
    expect(formatReport(s)).toContain("NOT A FINDING: fewer than 5 runs");
    expect(formatReport(s)).not.toContain("NO METRIC SAW THE COST");
  });
});

describe("formatReport", () => {
  it("prints both boards' runs beside their medians, and the delta beside the spread", () => {
    const report = formatReport(
      summary([{ tapAt: 450, arms: [arm({ inp: [340, 350, 360, 345, 355] }), arm({ inp: [250, 262, 258, 255, 260] })] }]),
    );
    expect(report).toContain("/board at 4x CPU, 45 dates (40 rows) against 15 dates (10 rows)");
    expect(report).toContain("Tap at 450 ms  (5 + 5 runs)");
    expect(report).toContain("350 [340 350 360 345 355]  vs    258 [250 262 258 255 260]");
    expect(report).toContain("delta 92, spread 20: sees the cost");
    expect(report).toContain("5 before hydration; 5 client transition");
    expect(report).toContain("INP with the tap at 450 ms (delta 92, spread 20)");
  });
});

describe("parseArgs", () => {
  it("defaults to five runs at 4x with the two tap offsets", () => {
    const args = parseArgs(["--db-container", "supabase_db_stack"]);
    expect(args).toMatchObject({ runs: 5, cpuRate: 4, tapAt: [450, 4000], stack: "http://127.0.0.1:54321" });
    expect(TAP_OFFSETS).toEqual([450, 4000]);
  });

  it("takes its own offsets, in both spellings of a flag", () => {
    expect(parseArgs(["--db-container", "c", "--tap-at", "300", "--tap-at=5000"]).tapAt).toEqual([300, 5000]);
  });

  it("requires the database container, because every run reseeds", () => {
    expect(() => parseArgs([])).toThrow(/--db-container is required/);
  });

  it("refuses a flag it does not know, a run count that is not a count, and a repeated offset", () => {
    expect(() => parseArgs(["--db-container", "c", "--throttling-method", "devtools"])).toThrow(/unknown flag --throttling-method/);
    expect(() => parseArgs(["--db-container", "c", "--runs", "0"])).toThrow(/--runs cannot be "0"/);
    expect(() => parseArgs(["--db-container", "c", "--runs", "many"])).toThrow(/--runs cannot be "many"/);
    expect(() => parseArgs(["--db-container", "c", "--cpu-rate"])).toThrow(/--cpu-rate cannot be undefined/);
    expect(() => parseArgs(["--db-container", "c", "--tap-at", "450", "--tap-at", "450"])).toThrow(/same offset twice/);
  });
});

describe("the runner's guard", () => {
  /**
   * Every run TRUNCATES, so the refusal has to land before anything is sent. This runs the real
   * runner with every key it would need to go further and a Supabase URL that is not loopback. If
   * the guard were dropped, stderr would carry "Minting" and the run would fail at the network.
   * The host is under `.invalid`, which never resolves, so a dropped guard reaches nobody.
   */
  it("refuses a Supabase that is not loopback before it mints or truncates anything", () => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/field-vitals.mjs", import.meta.url)),
        "--db-container",
        "no_such_container",
        "--stack",
        "https://supabase.invalid",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STACK_ANON_KEY: "anon", STACK_SERVICE_ROLE_KEY: "service" },
        timeout: 30_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to seed a non-local Supabase at https://supabase.invalid");
    expect(r.stderr).not.toContain("Minting");
  });
});
