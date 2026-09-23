import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_BAND,
  buildSummary,
  lighthouseArgs,
  parseArgs,
  THROTTLING_METHODS,
  FLOORS,
  fixtureId,
  fixturePlan,
  fixtureSql,
  formatReport,
  adminEmailFor,
  measuredPost,
  measuredRoutes,
  measuredViewer,
  median,
  refuseNonLocalStack,
  refuseWrongPage,
  readReport,
  requestHeaders,
  runTarget,
  VOLUME,
  summariseRoute,
  verdict,
} from "../scripts/lighthouse-floor-core.mjs";

/**
 * The half of `perf:floor` that can be tested without Docker, Chrome or a network (story #44).
 *
 * What these tests are FOR, since a fixture generator can look like a thing not worth testing:
 * the number the command prints means nothing except against a stated volume, and the volume is a
 * claim about the board that only a test can hold. `docs/performance-floor.md` says the board was
 * measured at 45 dates and 50 posts. If `fixturePlan` quietly drifted to 12 dates, every re-run
 * would report a better number for a page nobody had measured, with nothing going red. So the
 * AC's own numbers are asserted here, and the schema constraints the fixture has to satisfy are
 * asserted beside them — `post`'s unique (boat, date) from 0006, `match`'s unique post and its
 * `skipper_id <> crew_id` check from 0008 — because a fixture that violates one of those fails at
 * seed time in a way that looks like a broken command rather than a wrong fixture.
 */

/** The shape `readReport` consumes, cut down to what it reads. */
function lhrFixture({
  performance = 0.85,
  accessibility = 0.95,
  cls = 0.02,
  url = "http://localhost:3100/board",
} = {}) {
  return {
    finalDisplayedUrl: url,
    lighthouseVersion: "12.8.2",
    categories: { performance: { score: performance }, accessibility: { score: accessibility } },
    audits: {
      "cumulative-layout-shift": { numericValue: cls },
      "first-contentful-paint": { numericValue: 1400 },
      "largest-contentful-paint": { numericValue: 4600 },
      "total-blocking-time": { numericValue: 150 },
      "server-response-time": { numericValue: 220 },
      "network-requests": { details: { items: [{}, {}, {}] } },
      "layout-shifts": { details: { items: [{ score: cls }] } },
    },
  };
}

describe("the floors", () => {
  // These three numbers are the acceptance criteria of #44 in machine-readable form. A change
  // here is a change to what the story promised, which is why it is asserted rather than assumed.
  it("are the ones issue #44 names", () => {
    expect(FLOORS).toEqual({ performance: 80, accessibility: 90, cls: 0.1 });
  });
});

describe("fixturePlan", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const plan = fixturePlan({ now });

  it("carries the volume the AC states", () => {
    expect(plan.dates).toHaveLength(45);
    expect(plan.posts.filter((p) => !p.matched)).toHaveLength(20);
    expect(plan.posts.filter((p) => p.matched)).toHaveLength(30);
    expect(plan.matches).toHaveLength(30);
    // Literals, not VOLUME.people: asserting a value against the constant that produced it moves
    // both sides together and pins nothing. The people count and the availability rows are most of
    // the board's server-side work, and docs/performance-floor.md states both as measured facts.
    expect(plan.people).toHaveLength(80);
    expect(plan.availability).toHaveLength(1125);
  });

  // 0006: `unique (boat_id, race_date_id)` on post. A collision makes the seed fail halfway with
  // a constraint error, which reads as the command being broken rather than the plan being wrong.
  it("gives every post a distinct (boat, race_date) pair", () => {
    const pairs = new Set(plan.posts.map((p) => `${p.boatId}|${p.raceDateId}`));
    expect(pairs.size).toBe(plan.posts.length);
  });

  // 0008: `post_id uuid not null unique` — the reason the AC's "20 posts and 30 matches" is read
  // as 50 posts. If this ever passes with 20 posts, the reading in VOLUME's comment is wrong.
  it("gives every match a distinct post, and only matched posts", () => {
    const postIds = new Set(plan.matches.map((m) => m.postId));
    expect(postIds.size).toBe(plan.matches.length);
    const matched = new Set(plan.posts.filter((p) => p.matched).map((p) => p.id));
    for (const m of plan.matches) expect(matched.has(m.postId)).toBe(true);
  });

  // 0008: `check (skipper_id <> crew_id)`. At the real volume this is an invariant the stride
  // arithmetic satisfies on its own, so it certifies the output without exercising the guard that
  // protects it — it cannot redden when that guard is removed. The second test is the one that can.
  it("never matches a skipper with themselves", () => {
    for (const m of plan.matches) expect(m.skipperId).not.toBe(m.crewId);
  });

  it("refuses the owner as their own crew even when the stride picks them first", () => {
    // Seven people and a stride of seven: for match i the only candidate index is i % 7, which is
    // also the boat owner's index in 6 of the 7 matches. So the `q.id !== boat.ownerId` filter is
    // load-bearing here and inert at the real volume.
    const forced = fixturePlan({
      now: new Date("2026-09-20T12:00:00Z"),
      volume: { people: 7, dates: 10, boats: 7, openPosts: 0, matchedPosts: 7, availabilityPerPerson: 3, answersPerOpenPost: 0 },
    });
    expect(forced.matches).toHaveLength(7);
    const collisions = forced.matches.filter((m, i) => {
      const post = forced.posts.find((p) => p.id === m.postId)!;
      const boat = forced.boats.find((b) => b.id === post.boatId)!;
      const firstByStride = forced.people.find((q) => q.rating != null && forced.people.indexOf(q) % 7 === i % 7);
      return firstByStride?.id === boat.ownerId;
    });
    expect(collisions.length).toBeGreaterThanOrEqual(6);
    for (const m of forced.matches) expect(m.skipperId).not.toBe(m.crewId);
  });

  // The shape the doc records — and the reason `now` is injected rather than pinned. A plan that
  // pinned its season to a literal date would drift here as the calendar moved, so this asserts
  // the shape holds at two instants six months apart rather than asserting a date.
  it("holds the board's shape — five sailed, forty upcoming — whenever it is run", () => {
    for (const at of [now, new Date("2027-03-01T12:00:00Z")]) {
      const p = fixturePlan({ now: at });
      const past = p.dates.filter((d) => new Date(d.startsAt) < at);
      expect(past).toHaveLength(5);
      expect(p.dates.length - past.length).toBe(40);
      // Every post sits on a date that has not sailed: the pool for a sailed date is empty, so a
      // post there would measure less work than the board really does.
      const upcoming = new Set(p.dates.filter((d) => new Date(d.startsAt) >= at).map((d) => d.id));
      for (const post of p.posts) expect(upcoming.has(post.raceDateId)).toBe(true);
    }
  });

  it("keeps its ids stable as the clock moves, because the runner puts one in a URL", () => {
    const later = fixturePlan({ now: new Date("2027-03-01T12:00:00Z") });
    expect(later.posts.map((p) => p.id)).toEqual(plan.posts.map((p) => p.id));
    expect(later.people.map((p) => p.id)).toEqual(plan.people.map((p) => p.id));
  });

  // src/post/post-form.ts's UUID regex is what /post/[id] tests before it reads anything, so an
  // id this generator produces has to satisfy it or the measured page is a 404.
  it("mints ids /post/[id] will accept", () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const p of plan.posts) expect(p.id).toMatch(UUID);
    for (const p of plan.people) expect(p.id).toMatch(UUID);
    // Two kinds at the same index must not collide — a person id and a post id are both #3.
    expect(fixtureId("person", 3)).not.toBe(fixtureId("post", 3));
  });
});

describe("fixtureSql", () => {
  const plan = fixturePlan({ now: new Date("2026-09-20T12:00:00Z") });
  const sql = fixtureSql(plan);

  it("wraps the whole seed in one transaction", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("writes one row per planned row", () => {
    const count = (table: string) => sql.split(`insert into public.${table} `).length - 1;
    expect(count("race_date")).toBe(45);
    expect(count("post")).toBe(50);
    expect(count("match")).toBe(30);
    expect(count("person")).toBe(plan.people.length);
    expect(count("availability")).toBe(plan.availability.length);
  });

  it("is re-runnable, so a second seed over a live stack is a no-op", () => {
    for (const line of sql.split("\n").filter((l) => l.startsWith("insert into"))) {
      expect(line).toContain("on conflict");
    }
  });

  // The fixture's own text is the only untrusted input this module has; a name carrying an
  // apostrophe would otherwise end the literal and turn the rest of the row into SQL.
  it("escapes a quote in a value rather than ending the literal", () => {
    const out = fixtureSql(plan, { clubName: "O'Brien's Sailing Club" });
    expect(out).toContain("'O''Brien''s Sailing Club'");
  });
});

describe("the measured viewer", () => {
  const plan = fixturePlan({ now: new Date("2026-09-20T12:00:00Z") });
  const viewer = measuredViewer(plan);

  /**
   * These four assertions exist because the first version of this command signed in as
   * `people[0]` — unrated, owner of nothing, and the club admin — so /board was scored with its
   * 45 availability forms suppressed and /post/[id] was scored as a bystander with neither the
   * contact panel nor the candidate list. A lighter page scores HIGHER, so that flattered every
   * number it touched, and on a passing route it is how a false pass is made.
   */
  it("is rated, so the board renders its availability controls", () => {
    expect(viewer.rating).not.toBeNull();
    expect(plan.availability.filter((a) => a.personId === viewer.id).length).toBeGreaterThan(0);
  });

  it("is not the club admin, so the measurement is a crew member's view", () => {
    expect(viewer.email).not.toBe(adminEmailFor(plan));
  });

  // The assertion above passes for the wrong reason on its own: `people[0]` is excluded by the
  // rating filter regardless of who the admin is, so the admin exclusion is inert at this volume
  // and could be deleted with nothing going red. Forcing the viewer's own address to be the
  // admin's is what makes that clause load-bearing in a test.
  it("steps past a person who IS the admin rather than measuring their view", () => {
    const other = measuredViewer(plan, viewer.email);
    expect(other.id).not.toBe(viewer.id);
    expect(other.rating).not.toBeNull();
  });

  it("owns an OPEN post, which is the heavy arm of /post/[id]", () => {
    const post = measuredPost(plan, viewer);
    expect(post.matched).toBe(false);
    const boat = plan.boats.find((b) => b.id === post.boatId)!;
    expect(boat.ownerId).toBe(viewer.id);
  });

  it("is specifically NOT people[0], the regression this replaced", () => {
    expect(plan.people[0].rating).toBeNull();
    expect(viewer.id).not.toBe(plan.people[0].id);
  });

  it("puts that post in the routes the run measures", () => {
    expect(measuredRoutes(plan)).toEqual(["/board", `/post/${measuredPost(plan, viewer).id}`]);
  });
});

describe("the runner's guards", () => {
  // Proven able to REFUSE, not merely to allow. assertLocal-as-was lived in the untested runner
  // and was the only thing standing between this command and seeding 80 people into production.
  it("refuses a Supabase URL that is not loopback", () => {
    expect(refuseNonLocalStack("https://abcdefg.supabase.co")).toMatch(/refusing to seed/);
    expect(refuseNonLocalStack("http://10.0.0.5:54321")).toMatch(/refusing to seed/);
    expect(refuseNonLocalStack("not a url at all")).toMatch(/not a URL/);
  });

  it("allows the three spellings of loopback", () => {
    for (const u of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]) {
      expect(refuseNonLocalStack(u)).toBeNull();
    }
  });

  // The /join trap: a build made without NEXT_PUBLIC_* pointed at the stack 302s to /join, which
  // is a small static form that scores WELL. Measuring it silently is the failure mode of the
  // whole command, so this guard is the one that makes the other numbers worth reading.
  it("refuses a report whose final URL is not the page asked for", () => {
    const r = refuseWrongPage("http://localhost:3100/board", { finalDisplayedUrl: "http://localhost:3100/join" });
    expect(r).toMatch(/asked for \S+\/board but Lighthouse measured \S+\/join/);
  });

  it("refuses a report that carries no final URL at all", () => {
    expect(refuseWrongPage("http://localhost:3100/board", {})).toMatch(/no final URL/);
  });

  it("allows a report that measured the page asked for", () => {
    expect(
      refuseWrongPage("http://localhost:3100/board", { finalDisplayedUrl: "http://localhost:3100/board" }),
    ).toBeNull();
  });
});

describe("runTarget — seeded and unseeded runs (#185)", () => {
  const plan = fixturePlan({ now: new Date("2026-06-01T12:00:00Z") });
  const live = "https://abcdefg.supabase.co";

  // The refusal that used to sit at the top of main() now lives here, so it has to be proven
  // here: a SEEDED run against the live project must still be refused before anything is read.
  it("refuses a seeded run against a Supabase that is not loopback", () => {
    expect(() => runTarget({ seed: true, stack: live, plan })).toThrow(/refusing to seed/);
  });

  it("refuses a seeded run that names its own viewer or route", () => {
    const stack = "http://127.0.0.1:54321";
    expect(() => runTarget({ seed: true, stack, viewerEmail: "someone@example.com", plan })).toThrow(/--no-seed/);
    expect(() => runTarget({ seed: true, stack, routes: ["/board"], plan })).toThrow(/--no-seed/);
  });

  it("measures the chosen viewer, both routes and the fixture volume on a seeded run", () => {
    const t = runTarget({ seed: true, stack: "http://127.0.0.1:54321", plan });
    expect(t).toEqual({
      email: measuredViewer(plan).email,
      routes: measuredRoutes(plan),
      volume: VOLUME,
      fixtureViewer: true,
    });
  });

  // The whole point of --no-seed: it writes nothing, so the live project is a legitimate target.
  it("lets an unseeded run name the live project, a real viewer and its own routes", () => {
    const t = runTarget({ seed: false, stack: live, viewerEmail: "crew@example.com", routes: ["/board"], plan });
    expect(t.email).toBe("crew@example.com");
    expect(t.routes).toEqual(["/board"]);
    expect(t.fixtureViewer).toBe(false);
  });

  // A real board's volume is not something the script can know, so a reading that named its own
  // viewer or routes must not inherit the fixture's numbers — the doc states the volume by hand.
  it("claims no volume once the viewer or the routes are named", () => {
    expect(runTarget({ seed: false, stack: live, viewerEmail: "crew@example.com", plan }).volume).toBeNull();
    expect(runTarget({ seed: false, stack: live, routes: ["/board"], plan }).volume).toBeNull();
  });

  it("keeps the fixture viewer and volume on an unseeded re-run that names nothing", () => {
    const t = runTarget({ seed: false, stack: "http://127.0.0.1:54321", plan });
    expect(t.volume).toBe(VOLUME);
    expect(t.fixtureViewer).toBe(true);
    expect(t.routes).toEqual(measuredRoutes(plan));
  });

  it("refuses a route that is not a path", () => {
    expect(() => runTarget({ seed: false, stack: live, routes: ["board"], plan })).toThrow(/a route is a path/);
  });
});

describe("requestHeaders (#185)", () => {
  it("sends only the cookie when no bypass secret is set", () => {
    expect(requestHeaders({ cookie: "sb-x-auth-token=abc" })).toEqual({ Cookie: "sb-x-auth-token=abc" });
  });

  // Vercel reads exactly this header name; a near-miss spelling is silently ignored and every
  // preview request 302s to its SSO page instead.
  it("adds Vercel's protection-bypass header when the secret is set", () => {
    expect(requestHeaders({ cookie: "c=1", bypassSecret: "s3cret" })).toEqual({
      Cookie: "c=1",
      "x-vercel-protection-bypass": "s3cret",
    });
  });

  it("refuses to build headers with no session cookie", () => {
    expect(() => requestHeaders({ cookie: "" })).toThrow(/no session cookie/);
  });
});

describe("readReport", () => {
  it("reports a category as the integer a person reads, not the fraction", () => {
    expect(readReport(lhrFixture({ performance: 0.78 })).performance).toBe(78);
    // 0.795 displays as 80 in Lighthouse's own UI; the AC's "at least 80" is that integer.
    expect(readReport(lhrFixture({ performance: 0.795 })).performance).toBe(80);
  });

  it("takes CLS from the audit rather than the category, so it can be argued about", () => {
    expect(readReport(lhrFixture({ cls: 0.0879 })).cls).toBe(0.0879);
  });

  // A report missing a category is a broken run, and scoring it as 0 would read as a page that
  // failed rather than a measurement that did not happen.
  it("refuses a report with no category score instead of scoring it zero", () => {
    const broken = lhrFixture();
    delete (broken.categories as Record<string, unknown>).performance;
    expect(() => readReport(broken)).toThrow(/performance category score/);
  });
});

describe("median", () => {
  it("takes the middle of an odd run and the mean of the two middles of an even one", () => {
    expect(median([73, 79, 78])).toBe(78);
    expect(median([70, 80])).toBe(75);
  });

  it("drops a null rather than counting it as zero", () => {
    expect(median([80, null, 82])).toBe(81);
    expect(median([null, undefined])).toBe(null);
  });
});

describe("verdict", () => {
  const route = (perf: number[], a11y = [95, 95, 95], cls = [0, 0, 0]) =>
    summariseRoute(
      "/board",
      perf.map((p, i) => readReport(lhrFixture({ performance: p / 100, accessibility: a11y[i] / 100, cls: cls[i] }))),
    );

  it("passes a route that clears every floor", () => {
    expect(verdict([route([88, 87, 90])]).pass).toBe(true);
  });

  it("fails on the median, not on the best run", () => {
    const v = verdict([route([81, 77, 77])]);
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toMatch(/performance 77 is below 80/);
  });

  // Exactly the floor is a pass: the AC says "at least 80".
  it("treats exactly the floor as met", () => {
    expect(verdict([route([80, 80, 80])]).pass).toBe(true);
    expect(verdict([route([90, 90, 90], [90, 90, 90])]).pass).toBe(true);
  });

  // The AC says CLS is "below 0.1", so 0.1 itself fails.
  it("requires CLS strictly below the floor", () => {
    expect(verdict([route([90, 90, 90], [95, 95, 95], [0.1, 0.1, 0.1])]).pass).toBe(false);
    expect(verdict([route([90, 90, 90], [95, 95, 95], [0.099, 0.099, 0.099])]).pass).toBe(true);
  });

  // A median of 80 drawn from 79/80/92 has not established which side of the floor the page is
  // on. It passes — the AC names a threshold — but the run must say so out loud.
  it("warns when the runs straddle the floor even though the median passes", () => {
    const v = verdict([route([79, 80, 92])]);
    expect(v.pass).toBe(true);
    expect(v.warnings[0]).toMatch(/straddle the floor of 80 — 79 \/ 80 \/ 92/);
  });

  it("does not warn when every run is on the same side", () => {
    expect(verdict([route([88, 87, 90])]).warnings).toEqual([]);
  });

  // The other same-side case, and the one the warning must not claim: a route whose every run is
  // BELOW the floor has not straddled anything — it has simply failed, and saying "straddle"
  // there would suggest the next run might clear it. Found by mutation: dropping the second half
  // of the straddle test reddened nothing until this existed.
  it("does not warn when every run is below the floor — that is a failure, not a straddle", () => {
    const v = verdict([route([73, 79, 78])]);
    expect(v.pass).toBe(false);
    expect(v.warnings).toEqual([]);
  });
});

describe("formatReport", () => {
  it("prints every run beside the median, so a spread cannot be hidden", () => {
    const s = summariseRoute(
      "/board",
      [73, 79, 78].map((p) => readReport(lhrFixture({ performance: p / 100 }))),
    );
    const out = formatReport([s], verdict([s]));
    expect(out).toContain("[73 79 78]");
    expect(out).toContain("FAIL");
  });
});

/**
 * #216: a devtools throttling mode, and the host speed that makes a devtools number readable.
 *
 * `simulate` and `devtools` agree on the board's score and disagree on its cost (LCP 5.1 s against
 * 3.0 s, TBT 0.31 s against 1.08 s), so a reading that does not say which it was cannot be compared
 * with anything. These tests hold the flag to what reaches Lighthouse, and hold the summary to what
 * Lighthouse reports having done.
 */

/** A report as Lighthouse writes it under a given method on a host of a given speed. */
function throttledReport(method: string | null, benchmarkIndex: number | null, performance = 0.66) {
  const lhr = lhrFixture({ performance }) as ReturnType<typeof lhrFixture> & Record<string, unknown>;
  if (method) lhr.configSettings = { throttlingMethod: method };
  if (benchmarkIndex != null) lhr.environment = { benchmarkIndex };
  return lhr;
}

const summarise = (method: string, indices: (number | null)[]) =>
  summariseRoute(
    "/board",
    indices.map((i) => readReport(throttledReport(method, i))),
  );

describe("lighthouseArgs (#216)", () => {
  const base = { url: "http://localhost:3100/board", headersFile: "h.json", outPath: "o.json" };

  it("passes --throttling-method=devtools when devtools is asked for, and no simulate", () => {
    const args = lighthouseArgs({ ...base, throttlingMethod: "devtools" });
    expect(args).toContain("--throttling-method=devtools");
    expect(args.filter((a) => a.startsWith("--throttling-method"))).toEqual(["--throttling-method=devtools"]);
  });

  // "Exactly as today": the argument list before #216 was a literal in the runner, so it is pinned
  // here as that literal, not rebuilt from the function under test.
  it("builds exactly the pre-#216 arguments when no method is named", () => {
    expect(lighthouseArgs(base)).toEqual([
      "--yes",
      "lighthouse@12",
      '"http://localhost:3100/board"',
      "--form-factor=mobile",
      "--screenEmulation.mobile",
      "--throttling-method=simulate",
      "--only-categories=performance,accessibility",
      '--extra-headers="h.json"',
      "--output=json",
      '--output-path="o.json"',
      '--chrome-flags="--headless=new"',
      "--quiet",
    ]);
  });

  it("refuses a method it does not know rather than handing it on", () => {
    expect(() => lighthouseArgs({ ...base, throttlingMethod: "provided" })).toThrow(/unknown throttling method/);
  });
});

describe("parseArgs --throttling-method (#216)", () => {
  const seeded = ["--db-container", "supabase_db_stack"];

  it("defaults to simulate, which is what every earlier reading used", () => {
    expect(parseArgs(seeded).throttlingMethod).toBe("simulate");
  });

  it("accepts devtools in both spellings of a flag", () => {
    expect(parseArgs([...seeded, "--throttling-method", "devtools"]).throttlingMethod).toBe("devtools");
    expect(parseArgs([...seeded, "--throttling-method=devtools"]).throttlingMethod).toBe("devtools");
  });

  it("refuses any other value, listing the accepted ones", () => {
    for (const bad of ["provided", "Devtools", "", "simulated"]) {
      expect(() => parseArgs([...seeded, "--throttling-method", bad])).toThrow(
        `--throttling-method must be one of ${THROTTLING_METHODS.join(", ")}`,
      );
    }
    expect(THROTTLING_METHODS).toEqual(["simulate", "devtools"]);
  });

  /**
   * The ordering half of the AC: the refusal lands before a stack is read, a row is seeded or
   * Chrome is launched. It runs the REAL runner with every key it would need to go further, and a
   * `--stack` on a closed port. If the refusal moved after the keys were checked, stderr would carry
   * "Seeding"; if it were dropped, the run would reach the stack and fail there instead.
   */
  it("makes the runner exit non-zero before it seeds anything", () => {
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/lighthouse-floor.mjs", import.meta.url)),
        "--db-container",
        "no_such_container",
        "--stack",
        "http://127.0.0.1:9",
        "--throttling-method",
        "fast",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STACK_ANON_KEY: "anon", STACK_SERVICE_ROLE_KEY: "service" },
        timeout: 30_000,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--throttling-method must be one of simulate, devtools");
    expect(r.stderr).not.toContain("Seeding");
    expect(r.stderr).not.toContain("Lighthouse");
  });
});

describe("benchmarkIndex and the method, read off the report (#216)", () => {
  it("keeps each run's environment.benchmarkIndex and the method Lighthouse reports", () => {
    const r = readReport(throttledReport("devtools", 1234.5));
    expect(r.benchmarkIndex).toBe(1234.5);
    expect(r.throttlingMethod).toBe("devtools");
  });

  it("reads null, not zero, from a report that carries neither", () => {
    const r = readReport(lhrFixture());
    expect(r.benchmarkIndex).toBeNull();
    expect(r.throttlingMethod).toBeNull();
  });

  it("puts the per-route median benchmarkIndex beside the scores, every run kept", () => {
    const s = summarise("devtools", [1500, 980, 1210]);
    expect(s.benchmarkIndex).toEqual({ median: 1210, values: [1500, 980, 1210] });
    expect(s.throttlingMethod).toBe("devtools");
    expect(s.performance.median).toBe(66);
  });

  it("records simulate for a simulate run", () => {
    expect(summarise("simulate", [1400, 1400, 1400]).throttlingMethod).toBe("simulate");
  });

  it("refuses to fold runs taken with different methods into one median", () => {
    expect(() =>
      summariseRoute("/board", [
        readReport(throttledReport("devtools", 1200)),
        readReport(throttledReport("simulate", 1200)),
      ]),
    ).toThrow(/mixes throttling methods/);
  });
});

describe("the benchmarkIndex band (#216)", () => {
  const bandWarnings = (v: ReturnType<typeof verdict>) => v.warnings.filter((w) => /benchmarkIndex/.test(w));

  it("is the band #216 AC 5 fixes", () => {
    expect(BENCHMARK_BAND).toEqual({ min: 920, max: 1680 });
  });

  it("warns on a devtools run whose median is above the band, naming the band", () => {
    const [w, ...rest] = bandWarnings(verdict([summarise("devtools", [2400, 2500, 2450])]));
    expect(rest).toEqual([]);
    expect(w).toMatch(/benchmarkIndex 2450 is outside 920–1680/);
    expect(w).toMatch(/does not represent a mid-range phone/);
  });

  it("warns on a devtools run whose median is below the band", () => {
    expect(bandWarnings(verdict([summarise("devtools", [900, 919, 700])]))[0]).toMatch(/benchmarkIndex 900 is outside/);
  });

  // Both edges are inside: the AC says "outside 920-1,680".
  it("does not warn at either edge of the band or inside it", () => {
    for (const idx of [920, 1300, 1680]) {
      expect(bandWarnings(verdict([summarise("devtools", [idx, idx, idx])]))).toEqual([]);
    }
  });

  // Only devtools is judged: under simulate the host's CPU does not set the reading the same way,
  // and every pre-#216 summary would otherwise start warning.
  it("does not judge a simulate run", () => {
    expect(bandWarnings(verdict([summarise("simulate", [2400, 2500, 2450])]))).toEqual([]);
  });

  // `null < 920` is true in JavaScript, so a missing index would otherwise read as a slow host.
  it("names a devtools run with no benchmarkIndex as unreadable rather than as slow", () => {
    const [w] = bandWarnings(verdict([summarise("devtools", [null, null, null])]));
    expect(w).toMatch(/carries no benchmarkIndex/);
    expect(w).not.toMatch(/is outside/);
  });

  it("prints the warning and records it in summary.json", () => {
    const s = summarise("devtools", [2400, 2500, 2450]);
    const v = verdict([s]);
    expect(formatReport([s], v)).toMatch(/WARNING .*benchmarkIndex 2450 is outside 920–1680/);
    const doc = JSON.parse(
      JSON.stringify(buildSummary({ takenAt: "t", target: {}, volume: VOLUME, summaries: [s], verdict: v })),
    );
    expect(doc.verdict.warnings.some((w: string) => /benchmarkIndex 2450 is outside 920–1680/.test(w))).toBe(true);
    expect(doc.summaries[0].throttlingMethod).toBe("devtools");
    expect(doc.summaries[0].benchmarkIndex.median).toBe(2450);
  });
});
