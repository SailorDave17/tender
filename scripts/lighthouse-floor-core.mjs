/**
 * perf:floor — the half that decides things, with no Docker, no browser and no network in it.
 * Story #44, which measures ADR 002's kill condition with the instrument that ADR names.
 *
 * WHAT QUESTION THIS ANSWERS
 *
 * ADR 002 chose Next.js and wrote its own kill condition: *Lighthouse mobile performance on the
 * board page below 80 ... unrecoverable by ordinary optimisation — reopen toward SvelteKit.* A
 * kill condition nobody can re-run is a sentence, not a condition, so the point of this file is
 * that the measurement survives the session that took it. #44 is the first run; the value is in
 * the second, after the board has grown.
 *
 * WHY THE FIXTURE IS GENERATED HERE RATHER THAN CHECKED IN AS SQL
 *
 * The number this command prints is only meaningful against a stated volume — a board with three
 * dates on it scores well and proves nothing. `fixturePlan()` builds that volume as data, and
 * `test/lighthouse-floor.test.ts` holds the plan to the AC's own numbers (45 dates, 20 open posts,
 * 30 matched) and to the schema's constraints. A checked-in .sql file could drift from both with
 * nothing going red, because no test can read a claim out of a literal it was written beside.
 *
 * The plan is DETERMINISTIC — ids are derived from an index, not from `gen_random_uuid()` — for
 * one operational reason: the runner has to name a post in a URL (`/post/<id>`), and a fixture
 * that renumbers itself on every seed makes that URL a thing to go and look up. It also makes two
 * runs comparable, which is the whole point of re-running it.
 *
 * WHY THE VERDICT ROUNDS BEFORE IT COMPARES
 *
 * Lighthouse stores a category score as a fraction already rounded to two decimals, and reports it
 * to a person as an integer out of 100. The AC says "at least 80", which is the integer a person
 * reads. So `verdict()` compares `Math.round(score * 100)`, not the fraction: comparing
 * `score >= 0.8` would fail a page the tool itself displays as 80. The CLS floor is the opposite
 * case — 0.1 is the raw metric and is compared raw, strictly below, as the AC words it.
 */

/** The AC's floors. Performance and accessibility are out of 100; CLS is the raw metric. */
export const FLOORS = { performance: 80, accessibility: 90, cls: 0.1 };

/**
 * The fixture's volume, from #44 AC 1. `matchedPosts` is 30 and `openPosts` is 20 because
 * `match.post_id` is UNIQUE in 0008 — one match per post — so the AC's "20 posts and 30 matches"
 * cannot mean 20 posts in total. 50 posts, 30 of them crewed, is the only reading that satisfies
 * both of its numbers and the schema (owner decision, 2026-09-20). It is also the heaviest of the
 * readings, since /board renders open and matched posts alike, so the floor is measured
 * conservatively rather than flatteringly.
 *
 * `people` and `availabilityPerPerson` are not in the AC and are derived from the charter's stated
 * volume (~80 people × ~45 dates, quoted in `src/board/load.ts`). They are not decoration: the
 * board computes `poolForDate` per date over every person, so the availability rows are most of
 * the server-side work the page does.
 */
export const VOLUME = {
  people: 80,
  dates: 45,
  boats: 30,
  openPosts: 20,
  matchedPosts: 30,
  availabilityPerPerson: 15,
  answersPerOpenPost: 4,
};

/**
 * A deterministic uuid for fixture row `n` of `kind`. The shape satisfies
 * `src/post/post-form.ts`'s UUID regex, which is what /post/[id] checks before it reads anything.
 * Distinct `kind` values keep two tables' ids from colliding when a person id and a post id are
 * both index 3.
 */
export function fixtureId(kind, n) {
  const k = [...kind].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 0xffff, 7);
  const tail = (n + 1).toString(16).padStart(6, "0");
  return `${k.toString(16).padStart(8, "0")}-0000-4000-8000-000000${tail}`;
}

/**
 * The fixture as data. `now` is injected, as every time-shaped module here injects it
 * (`src/dates/race-date.ts`, `src/auth/*.ts`), and the dates are derived FROM it rather than
 * pinned to an instant.
 *
 * That is the opposite of what it first looks like it should be, and the reason is worth keeping.
 * Pinning the season to a literal date makes the ids and the timestamps reproducible while making
 * the *board* drift: every week that passes moves another date from "upcoming" to "sailed", so a
 * re-run six months later renders 45 past dates, no live pool and almost no work — and reports a
 * flattering number for a page nobody would recognise. What a re-run has to hold constant is the
 * SHAPE of the board, so the shape is what is pinned: five dates already sailed, forty upcoming,
 * whenever it is run. The ids stay deterministic because they are derived from an index, which is
 * the half the runner needs when it puts a post id in a URL.
 */
export function fixturePlan({ volume = VOLUME, now = new Date() } = {}) {
  const WEEK = 7 * 24 * 3600 * 1000;
  // Two days clear of `now`, so the fifth date is unambiguously upcoming and the fourth
  // unambiguously sailed. Landing one exactly on `now` would make the board's past/future split
  // depend on which side of a millisecond the render fell.
  const seasonAnchor = now.getTime() + 2 * 24 * 3600 * 1000;
  const people = Array.from({ length: volume.people }, (_, i) => ({
    id: fixtureId("person", i),
    email: `crew${String(i).padStart(3, "0")}@fixture.invalid`,
    displayName: `Fixture Crew ${i + 1}`,
    // A rating is what puts a person in a date's pool; a handful are left unrated because the
    // board withholds the toggles from those and that arm should be on the page too.
    rating: i % 17 === 0 ? null : (i % 4) + 1,
  }));

  const dates = Array.from({ length: volume.dates }, (_, i) => ({
    id: fixtureId("race_date", i),
    // Weekly, five of them behind the anchor so the board carries its "Already sailed" arm too.
    startsAt: new Date(seasonAnchor + (i - 5) * WEEK).toISOString(),
    title: `Sunday Series ${i + 1}`,
  }));

  const classes = ["Thistle", "Highlander", "Interlake", "MC Scow", "Flying Scot", "Windmill"];
  const boats = Array.from({ length: volume.boats }, (_, i) => ({
    id: fixtureId("boat", i),
    ownerId: people[i % people.length].id,
    name: `Fixture Boat ${i + 1}`,
    class: classes[i % classes.length],
    defaultMinimum: (i % 4) + 1,
  }));

  // 50 posts over unique (boat, race_date) pairs — `post` carries that unique constraint (0006).
  // Walking boat and date on co-prime-ish strides keeps every pair distinct without a set.
  const total = volume.openPosts + volume.matchedPosts;
  const posts = Array.from({ length: total }, (_, i) => {
    const matched = i >= volume.openPosts;
    return {
      id: fixtureId("post", i),
      boatId: boats[i % boats.length].id,
      // Spread over the FUTURE dates: a post on a date that has sailed is not what the board is
      // for, and the pool for a past date is empty, so it would measure less work than it should.
      raceDateId: dates[5 + (i % (volume.dates - 5))].id,
      minimum: (i % 3) + 1,
      note: matched ? "" : `Crew wanted for race ${i + 1}. Bring foulies.`,
      matched,
      currentRung: (i % 3) + 1,
    };
  });

  const matches = posts
    .filter((p) => p.matched)
    .map((p, i) => {
      const boat = boats.find((b) => b.id === p.boatId);
      // The crew is anyone but the skipper — `match` carries `check (skipper_id <> crew_id)`.
      const crew = people.find((q) => q.id !== boat.ownerId && q.rating != null && people.indexOf(q) % 7 === i % 7);
      return {
        id: fixtureId("match", i),
        postId: p.id,
        skipperId: boat.ownerId,
        crewId: (crew ?? people.find((q) => q.id !== boat.ownerId)).id,
        status: ["accepted", "confirmed", "sailed", "no_show"][i % 4],
      };
    });

  // Availability: each person marks a stride of the dates. The stride differs per person so the
  // per-date counts vary, which is what the board prints under each date.
  const availability = [];
  for (const [i, person] of people.entries()) {
    if (person.rating == null) continue;
    for (let k = 0; k < volume.availabilityPerPerson; k += 1) {
      const d = dates[(i * 3 + k * 7) % dates.length];
      if (!availability.some((a) => a.personId === person.id && a.raceDateId === d.id)) {
        availability.push({ personId: person.id, raceDateId: d.id });
      }
    }
  }

  // Answers on the open posts only: a matched post is closed and takes no more.
  const answers = [];
  for (const [i, post] of posts.entries()) {
    if (post.matched) continue;
    const boat = boats.find((b) => b.id === post.boatId);
    for (let k = 0; k < volume.answersPerOpenPost; k += 1) {
      const person = people[(i * 5 + k * 11) % people.length];
      if (person.id === boat.ownerId || person.rating == null) continue;
      if (!answers.some((a) => a.postId === post.id && a.personId === person.id)) {
        answers.push({ postId: post.id, personId: person.id });
      }
    }
  }

  return { people, dates, boats, posts, matches, availability, answers };
}

/**
 * Who the run signs in as, and which post it opens. Both are CHOSEN here rather than taken by
 * index in the runner, and that distinction is the whole reason this function exists.
 *
 * The first version of this command signed in as `people[0]` because it was the first person in
 * the list. `fixturePlan` makes every seventeenth person unrated, and index 0 is the first of
 * them — so the board was scored with `unrated` true, which suppresses all 45 availability forms,
 * their 45 `aria-pressed` buttons and their 90 hidden inputs, and `people[0]` owned 0 of the 1,125
 * availability rows. `people[0]`'s address was also handed to `club.admin_email`, so 0009's
 * trigger made the measured viewer an admin as well. The page measured was lighter than any real
 * crew member's, and nothing said so.
 *
 * A LIGHTER PAGE SCORES HIGHER, so that error flatters every number it touches. On a route that
 * fails it only understates the failure; on a route that PASSES it is how a false pass is
 * manufactured. Hence three requirements, each asserted in `test/lighthouse-floor.test.ts`:
 *
 * 1. **Rated**, so the board renders its availability controls — the board's main interactive
 *    surface, and the half an accessibility score most needs to see.
 * 2. **Not the club admin**, so the measurement is the view a crew member gets. The admin sees
 *    strictly more, and is the rarer reader.
 * 3. **The owner of an OPEN post**, which is the heaviest arm of `/post/[id]`: the owner of an
 *    open post sees the full candidate list, one row per available crew with a rung badge and an
 *    Accept button, plus the Close control. A *matched* post is the light arm, not the heavy one —
 *    it renders a name-only panel, and to a non-party it renders neither contact nor candidates.
 */
export function measuredViewer(plan, adminEmail = adminEmailFor(plan)) {
  const viewer = plan.people.find(
    (p) =>
      p.rating != null &&
      p.email !== adminEmail &&
      plan.boats.some((b) => b.ownerId === p.id && plan.posts.some((q) => !q.matched && q.boatId === b.id)),
  );
  if (!viewer) throw new Error("no rated non-admin person owns an open post — the fixture cannot be measured as a crew member");
  return viewer;
}

/**
 * The club's admin is deliberately the LAST person rather than the first, so that the viewer
 * `measuredViewer` picks can never also be the admin by construction rather than by luck.
 */
export function adminEmailFor(plan) {
  return plan.people[plan.people.length - 1].email;
}

/** The open post the viewer owns — the heavy arm of `/post/[id]`. See `measuredViewer`. */
export function measuredPost(plan, viewer = measuredViewer(plan)) {
  const boatIds = new Set(plan.boats.filter((b) => b.ownerId === viewer.id).map((b) => b.id));
  const post = plan.posts.find((p) => !p.matched && boatIds.has(p.boatId));
  if (!post) throw new Error("the measured viewer owns no open post");
  return post;
}

/** The routes the AC names, with the post resolved to the arm `measuredViewer` was chosen for. */
export function measuredRoutes(plan) {
  return ["/board", `/post/${measuredPost(plan).id}`];
}

/**
 * Loopback only. This command SEEDS — 80 people, 45 dates, 50 posts — so against the live project
 * it would be vandalism. Returns the refusal message, or null when the URL is acceptable; the
 * runner throws it. Split this way so it can be proven able to refuse without a network.
 */
export function refuseNonLocalStack(url) {
  let hostname;
  try {
    ({ hostname } = new URL(url));
  } catch {
    return `not a URL: ${url}`;
  }
  if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) return null;
  return `refusing to seed a non-local Supabase at ${url} — this command writes 80 people and 50 posts`;
}

/**
 * Who signs in, which routes are measured, and what volume the reading may claim — decided once,
 * here, for both shapes of run. Story #185.
 *
 * A SEEDED run measures the fixture and nothing else: the viewer and the routes are the ones
 * `measuredViewer` chose, and naming another viewer or route is refused rather than honoured,
 * because a seeded run's whole value is that its number is comparable with every other seeded
 * run's. Letting a flag swap the viewer would reintroduce, by argument, the lighter-page defect
 * `measuredViewer` exists to prevent.
 *
 * An UNSEEDED run writes nothing, so it may point at any Supabase — the live project included,
 * which is how ADR 002's condition gets re-read once the club's real board has grown. There the
 * viewer and routes may be named, and when either is, the reading claims NO volume: the script
 * cannot know what a real board carries, so `volume` is null and the doc has to state it beside
 * the number. Only an unseeded run over the fixture's own viewer and routes inherits `VOLUME`.
 *
 * @param {{ seed: boolean, stack: string, viewerEmail?: string | null, routes?: string[],
 *           plan: ReturnType<typeof fixturePlan> }} options
 */
export function runTarget({ seed, stack, viewerEmail = null, routes = [], plan }) {
  if (seed) {
    const refusal = refuseNonLocalStack(stack);
    if (refusal) throw new Error(refusal);
    if (viewerEmail || routes.length) {
      throw new Error("a seeded run measures the fixture's chosen viewer and routes — pass --no-seed to name your own");
    }
    return { email: measuredViewer(plan).email, routes: measuredRoutes(plan), volume: VOLUME, fixtureViewer: true };
  }
  for (const r of routes) {
    if (!r.startsWith("/")) throw new Error(`a route is a path, not ${JSON.stringify(r)}`);
  }
  const named = Boolean(viewerEmail) || routes.length > 0;
  return {
    email: viewerEmail ?? measuredViewer(plan).email,
    routes: routes.length ? routes : measuredRoutes(plan),
    volume: named ? null : VOLUME,
    fixtureViewer: !viewerEmail,
  };
}

/**
 * The headers every request of the run carries: the session cookie, and — only when the secret is
 * set — Vercel's protection-bypass header, without which a PREVIEW deployment answers every
 * request with a 302 to Vercel's own sign-in (measured on #185: `ssoProtection` is
 * `all_except_custom_domains`, so production's custom domain is open and every preview is not).
 * That 302 is `/join`'s trap in a second dress — a page nobody asked for — so `refuseWrongPage`
 * would catch it; the header is what makes the preview measurable at all.
 *
 * The secret comes from the environment and never from a flag, so it does not land in shell
 * history or in the committed summary.
 *
 * @param {{ cookie: string, bypassSecret?: string | null }} options
 */
export function requestHeaders({ cookie, bypassSecret = null }) {
  if (!cookie) throw new Error("no session cookie — the run would measure a signed-out redirect");
  return bypassSecret ? { Cookie: cookie, "x-vercel-protection-bypass": bypassSecret } : { Cookie: cookie };
}

/**
 * Did Lighthouse measure the page that was asked for? Returns a refusal message or null.
 *
 * This is the guard that makes every other number in the report worth reading. If the build was
 * made without `NEXT_PUBLIC_*` pointing at the local stack, the Edge proxy talks to a different
 * project, finds no valid session and 302s to `/join` — and `/join` is a small static form that
 * scores WELL. So the failure mode of the whole measurement is a reassuring number for a page
 * nobody asked about.
 */
export function refuseWrongPage(requested, lhr) {
  const got = lhr?.finalDisplayedUrl ?? lhr?.finalUrl;
  if (!got) return "report carries no final URL — cannot tell what was measured";
  let a, b;
  try {
    a = new URL(requested).pathname;
    b = new URL(got).pathname;
  } catch {
    return `could not compare ${requested} with ${got}`;
  }
  if (a !== b) return `asked for ${requested} but Lighthouse measured ${got} — the session did not survive the request`;
  return null;
}

const q = (s) => `'${String(s).replaceAll("'", "''")}'`;

/**
 * The plan as SQL, for everything except `auth.users` — those are minted through GoTrue's admin
 * API by the runner, because a hand-seeded `auth.users` row breaks every auth call with an error
 * naming a column rather than the cause (cairn: the #25 finding in this repo's overlay).
 *
 * Every insert is `on conflict do nothing` so a re-seed over a live stack is a no-op rather than a
 * failure, and the runner can be run twice without a reset.
 */
export function fixtureSql(plan, { clubName = "Fixture Sailing Club", adminEmail = null } = {}) {
  const lines = ["begin;"];

  lines.push(
    `insert into public.club (id, name, brand_disc, brand_mark, invite_code, admin_email) values (${fixtureId("club", 0) && q(fixtureId("club", 0))}, ${q(clubName)}, '#1f3b2c', '#edf0ea', 'FIXTURE', ${adminEmail ? q(adminEmail) : "null"}) on conflict (id) do nothing;`,
  );

  for (const p of plan.people) {
    lines.push(
      `insert into public.person (id, display_name, adult_attested_at, rating) values (${q(p.id)}, ${q(p.displayName)}, now(), ${p.rating ?? "null"}) on conflict (id) do nothing;`,
      `insert into public.person_contact (person_id, email) values (${q(p.id)}, ${q(p.email)}) on conflict (person_id) do nothing;`,
    );
  }
  for (const d of plan.dates) {
    lines.push(
      `insert into public.race_date (id, starts_at, title, published) values (${q(d.id)}, ${q(d.startsAt)}, ${q(d.title)}, true) on conflict (id) do nothing;`,
    );
  }
  for (const b of plan.boats) {
    lines.push(
      `insert into public.boat (id, owner_id, name, class, default_minimum) values (${q(b.id)}, ${q(b.ownerId)}, ${q(b.name)}, ${q(b.class)}, ${b.defaultMinimum}) on conflict (id) do nothing;`,
    );
  }
  for (const p of plan.posts) {
    lines.push(
      `insert into public.post (id, boat_id, race_date_id, minimum, note, closed_at, current_rung) values (${q(p.id)}, ${q(p.boatId)}, ${q(p.raceDateId)}, ${p.minimum}, ${q(p.note)}, ${p.matched ? "now()" : "null"}, ${p.currentRung}) on conflict (id) do nothing;`,
    );
  }
  for (const m of plan.matches) {
    lines.push(
      `insert into public.match (id, post_id, skipper_id, crew_id, status) values (${q(m.id)}, ${q(m.postId)}, ${q(m.skipperId)}, ${q(m.crewId)}, ${q(m.status)}) on conflict (post_id) do nothing;`,
    );
  }
  for (const a of plan.availability) {
    lines.push(
      `insert into public.availability (person_id, race_date_id) values (${q(a.personId)}, ${q(a.raceDateId)}) on conflict do nothing;`,
    );
  }
  for (const a of plan.answers) {
    lines.push(
      `insert into public.answer (post_id, person_id) values (${q(a.postId)}, ${q(a.personId)}) on conflict do nothing;`,
    );
  }

  lines.push("commit;");
  return lines.join("\n");
}

/**
 * The handful of numbers worth keeping out of a 2–4 MB Lighthouse report. `cls` and the timings
 * come from the audits rather than from the category, because a category score is a weighted fold
 * and cannot answer "why".
 */
export function readReport(lhr) {
  const cat = (name) => {
    const c = lhr?.categories?.[name];
    if (!c || typeof c.score !== "number") throw new Error(`report carries no ${name} category score`);
    return Math.round(c.score * 100);
  };
  const audit = (id) => lhr?.audits?.[id]?.numericValue ?? null;
  return {
    url: lhr?.finalDisplayedUrl ?? lhr?.finalUrl ?? null,
    lighthouseVersion: lhr?.lighthouseVersion ?? null,
    performance: cat("performance"),
    accessibility: cat("accessibility"),
    cls: audit("cumulative-layout-shift"),
    fcp: audit("first-contentful-paint"),
    lcp: audit("largest-contentful-paint"),
    tbt: audit("total-blocking-time"),
    ttfb: audit("server-response-time"),
    requests: lhr?.audits?.["network-requests"]?.details?.items?.length ?? null,
    /** Every shifting element Lighthouse attributed, so a CLS figure can be argued about later. */
    shifts: (lhr?.audits?.["layout-shifts"]?.details?.items ?? []).length,
  };
}

/** The middle value, or the mean of the two middles. Nulls are dropped, not counted as zero. */
export function median(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Fold N runs of one route into the shape the doc records. The individual values are kept beside
 * the median deliberately: a Lighthouse median that hides its spread is how a page that reads 79
 * one run in three gets recorded as passing (cairn:
 * lighthouse-simulated-scores-race-the-font-files-2026-09-04).
 */
export function summariseRoute(route, reports) {
  if (!reports.length) throw new Error(`route ${route} has no reports`);
  const pick = (k) => reports.map((r) => r[k]);
  return {
    route,
    runs: reports.length,
    performance: { median: median(pick("performance")), values: pick("performance") },
    accessibility: { median: median(pick("accessibility")), values: pick("accessibility") },
    cls: { median: median(pick("cls")), values: pick("cls") },
    lcp: { median: median(pick("lcp")), values: pick("lcp") },
    tbt: { median: median(pick("tbt")), values: pick("tbt") },
    ttfb: { median: median(pick("ttfb")), values: pick("ttfb") },
    requests: median(pick("requests")),
    lighthouseVersion: reports[0].lighthouseVersion,
  };
}

/**
 * Pass or fail against the floors, per route and per metric.
 *
 * The spread is reported as a `warning` rather than a failure, and that split is deliberate: the
 * AC names a threshold, so the threshold decides the verdict, but a route whose runs straddle the
 * floor has not really established which side it is on and the doc must say so. Silently passing
 * on a median of 80 drawn from 79/80/92 is the failure this exists to make visible.
 */
export function verdict(summaries, floors = FLOORS) {
  const failures = [];
  const warnings = [];
  for (const s of summaries) {
    if (s.performance.median < floors.performance) {
      failures.push(`${s.route}: performance ${s.performance.median} is below ${floors.performance}`);
    }
    if (s.accessibility.median < floors.accessibility) {
      failures.push(`${s.route}: accessibility ${s.accessibility.median} is below ${floors.accessibility}`);
    }
    if (s.cls.median != null && s.cls.median >= floors.cls) {
      failures.push(`${s.route}: CLS ${s.cls.median} is not below ${floors.cls}`);
    }
    for (const [metric, floor] of [
      ["performance", floors.performance],
      ["accessibility", floors.accessibility],
    ]) {
      const vs = s[metric].values;
      if (vs.some((v) => v < floor) && vs.some((v) => v >= floor)) {
        warnings.push(`${s.route}: ${metric} runs straddle the floor of ${floor} — ${vs.join(" / ")}`);
      }
    }
  }
  return { pass: failures.length === 0, failures, warnings };
}

/** The run as a person reads it. Kept here so the runner holds no formatting worth testing. */
export function formatReport(summaries, v, floors = FLOORS) {
  const out = [];
  for (const s of summaries) {
    out.push(`${s.route}  (${s.runs} run${s.runs === 1 ? "" : "s"}, Lighthouse ${s.lighthouseVersion})`);
    out.push(
      `  performance   ${String(s.performance.median).padStart(3)}  [${s.performance.values.join(" ")}]  floor ${floors.performance}`,
    );
    out.push(
      `  accessibility ${String(s.accessibility.median).padStart(3)}  [${s.accessibility.values.join(" ")}]  floor ${floors.accessibility}`,
    );
    out.push(
      `  CLS         ${String(s.cls.median ?? "n/a").padStart(5)}  [${s.cls.values.join(" ")}]  floor < ${floors.cls}`,
    );
    out.push(
      `  LCP ${Math.round(s.lcp.median ?? 0)} ms · TBT ${Math.round(s.tbt.median ?? 0)} ms · TTFB ${Math.round(s.ttfb.median ?? 0)} ms · ${s.requests} requests`,
    );
  }
  for (const w of v.warnings) out.push(`WARNING  ${w}`);
  for (const f of v.failures) out.push(`FAIL     ${f}`);
  out.push(v.pass ? "PASS — every floor met." : "FAIL — ADR 002's kill condition is in play; see docs/performance-floor.md.");
  return out.join("\n");
}
