# Performance floor — the board and post pages

What ADR 002's kill condition reads today, how it was measured, and which levers were priced
against it. Story #44 took the local reading; story #185 took the deployed one, which is the
reading that decides the condition — **jump to [The deployed reading, 2026-09-22](#the-deployed-reading-2026-09-22--story-185)**.

Re-run it with `npm run perf:floor` (see *Running it* at the foot). The command is the record's
instrument, not a convenience: a kill condition nobody can re-run is a sentence, not a condition.

## The floors

From issue #44 AC 1 and AC 2, held in `scripts/lighthouse-floor-core.mjs` as `FLOORS` and asserted
in `test/lighthouse-floor.test.ts`:

- performance **at least 80**
- accessibility **at least 90**
- CLS **below 0.1**

## Who the measurement signs in as, and why it is stated first

A Lighthouse score is a score *of a page*, and these pages render differently for different people.
The first version of this command signed in as the first person in the fixture, who happens to be
unrated and to hold the club's admin address — so the board rendered with all 45 availability forms
suppressed, and `/post/[id]` rendered to a bystander with neither the contact panel nor the
candidate list. **A lighter page scores higher**, so those numbers flattered both routes: `/board`
read 78 where it now reads 72, and `/post/[id]` read 88 where it now reads 83.

The viewer is therefore **chosen** rather than taken, by `measuredViewer()`, and the choice is
asserted in the test file: **rated** (so the board renders its availability controls), **not the
club admin** (so this is a crew member's view), and **the owner of an open post** (so `/post/[id]`
renders its heavy arm — the full candidate list, one row per available crew with a rung badge and
an Accept button). A *matched* post is the light arm, which is the opposite of what it was first
taken for.

## The reading, 2026-09-21

Lighthouse 12.8.2, mobile preset, simulated throttling, against a `next build` + `next start`
production build served from `localhost`, with a signed-in session cookie passed via
`--extra-headers`. Fixture: **80 people, 45 published race dates, 50 posts (20 open, 30 crewed),
30 matches, 1,125 availability rows**. Median of three runs, every run shown.

| route | performance | accessibility | CLS | document | DOM | requests |
|---|---|---|---|---|---|---|
| `/board` | **72** (72 / 78 / 72) | 96 (95/96/96) | 0.000 (0.087/0/0) | 151 KB | 699 | 13 |
| `/post/[id]` | **83** (90 / 78 / 83) | 96 (96/96/96) | 0.000 | 55 KB | 176 | 17 |

**Accessibility and CLS meet their floors on both routes. `/board` misses the performance floor by
eight points. `/post/[id]` passes on the median and should not be read as safe:** its three runs
are 90 / 78 / 83, so one of them is *below* the floor. The command raises that as a warning rather
than a failure — the AC names a threshold and the median meets it — but a route whose runs straddle
the floor has not established which side it is on.

Only the LCP audit is poor. On the board's worst run FCP scores 0.96, TBT 0.94 and Speed Index
0.97, while LCP scores 0.30.

## Why, and what was ruled out

Lighthouse's simulated throttling records an unthrottled trace and replays it under a slow-4G
model, and one of its pruning rules is that **anything finishing before the observed first paint is
treated as render-blocking**. On `/board` every resource lands by ~540 ms while the observed paint
is usually at ~1,450 ms, so the whole payload — 151 KB of document plus **455 KB of React/Next
client runtime** — is priced onto the simulated critical path. That is the ~5 s LCP.

| `/board` arm | runs | median |
|---|---|---|
| **as it now stands, `prefetch={false}` on every board link** | 72 / 78 / 72 | **72** |
| framework JS blocked (`--blocked-url-patterns`) — a bound, not a shippable fix | 96 / 96 / 96 | **96** |

**The framework runtime is worth about 24 points, and nothing else moved the number at all.** Three
app-level levers were each priced as their own arm:

| lever | effect |
|---|---|
| `prefetch={false}` on every board link — kept, 27 requests → 13 | ~3 points |
| document cut by 71% (10 dates instead of 45) | **none** |
| both client components removed entirely | **none** |

Those three arms were measured **before** the viewer defect above was found, so their absolute
numbers (75 → 78, then 78, then 77) are from the lighter page and are not comparable with the 72 in
the table. They remain comparable **with each other**, which is what a lever arm is for, and the
framework-JS arm has since been re-measured on the correct page at 96 — so the shape of the
conclusion is unchanged. What each settled:

- **Prefetch was real but small.** The board carries a `<Link>` per post and Next prefetched every
  one; each prefetch is a full server render of a `force-dynamic` page against Supabase. It is kept
  for a second reason that has nothing to do with Lighthouse: a 50-post board was firing ~50
  dynamic server renders per view on Vercel Hobby and a free-tier Supabase.
- **Document size is not the lever.** Cutting 84 KB of HTML — 71% — moved the median by nothing.
  This was the intuitive candidate and it is wrong, which is why the arm is recorded rather than
  dropped.
- **Nor are the client components.** `/board` is the only page carrying any
  (`RegisterServiceWorker`, `InstallBanner`); removing both left it where it was, and Next still
  shipped all 455 KB — the client runtime goes to every route whether or not the route uses it.

### CLS is the install banner, not a font swap

AC 2 anticipated a font swap and prescribed metric-adjusted fallback faces. **That repair is
inapplicable here: the app loads no web fonts at all** — `src/app/globals.css` and the board both
specify `system-ui, sans-serif`, and there is no `next/font`, no `@font-face` and no Google Fonts
origin anywhere in `src/`.

The shift is `InstallBanner`. It renders `null` on the server, and after hydration its effect
resolves `installAdvice` and renders an `<aside>` above the race-day list, pushing the whole `<ol>`
down. Lighthouse attributes the shift to `body > main > ol`, which is the element that moves rather
than the one that causes it.

It is a **real** shift, not a measurement artefact: the run renders
`data-install-advice="browser-prompt"`, meaning Chromium fired `beforeinstallprompt` against
Tender's manifest and service worker exactly as it would for an Android crew who has not installed
and not dismissed. The control confirms it from the other side — with both client components
removed, CLS reads 0.000.

**It is also intermittent, and that is the thing to know.** Across the runs recorded here it reads
0.087 when the page paints late and 0.000 when it paints early, because a shift is only counted
after the first paint. So the floor is met on the median while a single run can carry ~87% of the
budget. Worth knowing before anything is added to that banner.

## What this means for ADR 002

**Where this stands now (2026-09-22).** ADR 002's lab condition fired on #185's deployed reading,
and the owner decided the same day to stay on Next.js 16. That condition is retired as the
framework trigger. The framework is reopened only by field data from members' phones, against
thresholds the ADR will carry before that data exists. `perf:floor` does not decide the framework:
it prices levers against a floor of 80. What follows is #44's reading of the condition as it stood
on 2026-09-21, kept as the record of how the question was worked.

ADR 002's kill condition: *"Lighthouse mobile performance on the board page below 80 on a mid-range
Android after the first three stories, unrecoverable by ordinary optimisation — reopen toward
SvelteKit."*

Locally, both halves have a reading: the board is at **72**, and of the three ordinary app-level
levers available, one bought about three points and two bought nothing, while the only arm that
cleared the floor was removing the framework runtime — which is the thing ADR 002 chose.

**But a local serve is the wrong instrument for this page shape, and it errs in the direction that
matters.** cairn's `lighthouse-simulated-scores-race-the-font-files-2026-09-04` records the same
shape — a page where everything finishes before the observed first paint on localhost — reading
**79 locally and 87 / 88 / 86 on production**. The mechanism is the pruning rule above: localhost
has no network latency, so *everything* lands before the paint and *everything* is priced onto the
critical path, where on a real network the later resources fall off it. If ~8 points carries here,
`/board` would read around 80 on `release` and the kill condition would not have fired at all.

So the honest verdict is narrower than the numbers first suggest:

- **Below 80 locally: established.** 72, with three runs and no sample near the floor.
- **Unrecoverable by ordinary optimisation: supported** — three levers priced, two at zero.
- **Below 80 on a mid-range Android, which is what the ADR actually says: not established**, and
  cannot be from this instrument.

At the time, the deciding measurement was taken to be the same command against the deployed
`release` build, and this section recorded only that the kill condition's local antecedent was met,
not that the framework decision was due.

*(Superseded 2026-09-22: that measurement has been taken, the ~8 points did **not** carry, and the
third bullet above is now established the other way. See the next section.)*

Two further things argue for care, both recorded because they cut against the finding:

1. **`/post/[id]` passes at 83 on the same 455 KB runtime** — the runtime does not sink a page on
   its own; it sinks a page that also pays a long render. But its runs straddle the floor, so it is
   not a comfortable pass either.
2. **The instrument is noisy.** `/board`'s three runs span 72–78 and `/post/[id]`'s span 78–90, on
   identical builds. A median of three is what the AC asks for; it is thin for this spread, which
   is why every individual run is printed beside its median and why `verdict()` raises a warning
   when a route's runs straddle the floor.

## The deployed reading, 2026-09-22 — story #185

**Verdict: `/board` reads below 80 on a deployed build of `release`, with every ordinary lever
priced, so ADR 002's kill condition has fired on the instrument the ADR names.** `/post/[id]`
passes on a deployed build once the footer regression below is fixed, and fails without it.

### Why this is five arms and not one

`release` was `a3decea` when this ran (deployed 16:58Z, carrying #44 and also #153/#154/#155/#147,
which landed after #44's local reading). Its production board could not answer the question alone:
**the live project had 0 published future race dates** (count-only read: 2 dates, 1 published and
past; 2 posts; 0 matches; 6 availability rows; 6 people, 4 rated). An empty board is a different
page from #44's 45-date one, and seeding production is not an option — the ladder tick would mail
real members about fixture posts. So the fixture was put on a deployment instead, and the cost of
doing that was measured rather than argued:

| arm | what is served | Supabase it talks to | board volume |
|---|---|---|---|
| **P** | production, `tender.madcowsailing.com` | the live project | the live board above |
| **Q** | a Vercel **preview** of `a3decea` | a local stack through a Cloudflare quick tunnel | seeded to the live board's counts |
| **R** | the same preview | the same stack, #44's fixture | 45 dates, 50 posts (20 open), 30 matches, 1,125 availability, 80 people |
| **R2** | a preview of `a3decea` plus one CSS line (not shipped — a lever arm) | as R | as R |
| **L** | `next build` + `next start` of the same tree on localhost | the same stack | as R |

P and Q hold the board shape constant and differ in the serving path, so **P − Q prices the
tunnel**: the preview's server renders reach the database over the public internet to this
machine rather than a few milliseconds to `us-east-2`. R and L hold the data constant and differ in
the network, so **R − L is the local/deployed gap** the cairn note predicted. P signs in as a real
crew account (rated, not the admin); Q, R, R2 and L as `measuredViewer`'s fixture crew (rated, not
the admin, owner of an open post — the heavy arm of `/post/[id]`). P's post is a live open post on
a past date and Q's a closed one on a past date, so their `/post` rows are the light arm; only R, R2
and L measure the heavy one.

Lighthouse 12.8.2, mobile preset, simulated throttling, Chrome 153, three runs per route, every run
shown. Machine-readable per arm in `docs/performance-floor/2026-09-22/`.

| arm | route | performance | accessibility | CLS | LCP | volume |
|---|---|---|---|---|---|---|
| P | `/board` | **86** (88 / 82 / 86) | 100 | 0.066 | 3.8 s | live: 0 upcoming dates |
| P | `/post/[id]` (light) | **88** (88 / 89 / 88) | 100 | 0.082 | 3.7 s | live |
| Q | `/board` | **82** (79 / 82 / 84) | 100 | 0.039 | 4.4 s | live counts |
| Q | `/post/[id]` (light) | **82** (83 / 82 / 79) | 100 | 0.080 | 4.4 s | live counts |
| R | `/board` | **66** (60 / 66 / 70) | 99 | **0.234** | 4.9 s | fixture |
| R | `/post/[id]` | **78** (78 / 78 / 76) | 100 | **0.112** | 4.6 s | fixture |
| R2 | `/board` | **70** (68 / 70 / 78) | 100 | 0.000 | 5.1 s | fixture |
| R2 | `/post/[id]` | **82** (82 / 80 / 90) | 100 | 0.000 | 4.5 s | fixture |
| L | `/board` | **68** (66 / 68 / 78) | 100 | **0.141** | 4.8 s | fixture |
| L | `/post/[id]` | **77** (77 / 73 / 82) | 100 | **0.141** | 4.6 s | fixture |

For comparison, #44's local reading on 2026-09-21, before #153–#155: `/board` 72, `/post/[id]` 83,
accessibility 96, CLS 0.000.

### The ~8-point local/deployed gap did not appear

R against L: **`/board` 66 deployed against 68 local, `/post/[id]` 78 against 77.** The tunnel
costs the deployed arms something (P − Q is **+4** on `/board` and **+6** on the light post), so
the fairest statement is that a deployed build of this app reads **somewhere between level with
and about four points above** a local serve — not the eight the cairn note's static page showed.

The mechanism says why, and it is the note's own rule applied rather than its number carried
over. Counting requests whose `networkEndTime` is at or before the observed first paint: locally
11–14 of 14 on `/board`; deployed 9–10 of 15 (R, Q) and 10 of 14 (P). The requests that fall off the
critical path on a real network are the small tail. **The ~457 KB of framework JavaScript lands
before first paint deployed as well** — Vercel's edge serves it from cache in time — so the
simulator still prices it as render-blocking, and that is where the score goes: the LCP audit
scores 0.24–0.32 in the three R runs on `/board`, against a 25-point weight. The page shape the note's 79 → 87 came from lost
its later resources to the network; this one does not have later resources worth losing.

*(Byte counts here are Chrome 153's decoded sizes, not the wire's — cairn
`chrome-decodes-before-lighthouse-sees-the-bytes`. That inflates the simulated cost of the JS in
every arm equally, so it does not move a comparison between arms; it does mean no number above is
a claim about transfer size.)*

### A regression since #44: the footer shifts

CLS was 0.000 on both routes in #44's reading. It now fails its floor on both, on the deployed
build and locally, and **the shifting element is the footer** (`body > footer`, `BuildStamp`'s
`<footer data-build-stamp>`, which #154's app shell places after the page) on every run that shifts: 0.066–0.141 alone, 0.234 on the board
where the install banner's known shift (`main > ol`, this doc's CLS section above) lands too.

The cause is, *by reasoning from the two observations below rather than by an arm that removed it*,
#154's root `loading.tsx`: the first paint is the shell with a one-line "Loading…"
`<main>` and the footer directly under it; the page then streams in above the footer and pushes it
down. The one `/board` and one `/post` run locally that read CLS 0 are the two whose first paint
came after everything had streamed — the same race #44 recorded for the banner. It costs the
performance score too, since CLS carries 25 of its 100 weight.

**R2 measured the lever**: one rule keeping the frame at least a viewport tall
(`#main[data-frame] { min-height: 100svh }`) holds the footer below the fold while the page streams,
and CLS went to 0 on both routes. It bought **`/board` +4 (66 → 70) and `/post/[id]` +4 (78 → 82)**.
The rule was applied to a scratch copy for the measurement and is **not** in this change; the
footer is its own story.

### What this settles

- **`/board` below 80 on a deployed build: established.** 66 as deployed, 70 with the footer fixed —
  and 74 to 76 even crediting the tunnel's whole measured cost to the deployed arms. No run of R or
  R2 reached 80.
- **Unrecoverable by ordinary optimisation: supported, with one more lever priced.** #44 priced
  three (prefetch ~3 points, kept; document size none; client components none). The footer is a
  fourth and bought 4. What remains is the simulated LCP of a page whose framework runtime lands
  before first paint on any network this was measured on, which is #44's attribution holding on a
  deployed build.
- **`/post/[id]`'s straddle is resolved**: it fails as deployed (78 / 78 / 76, every run below) and
  passes with the footer fixed (82 / 80 / 90, every run at or above). So it passes on this
  framework, conditional on that fix.
- **On the live board today** — empty, for the season — both routes pass (86 and 88). That is a
  lighter page and is recorded for completeness and as the tunnel's control, not as evidence about
  the floor.

What this does **not** establish: a physical mid-range Android. The ADR names Lighthouse's mobile
preset as the instrument, and that is what was run; a phone on cellular was not.

## Running it

```
# 1. a local Supabase stack, in a scratch directory, never in the repo
npx supabase init --force
rm -rf supabase/migrations && cp -r <tender>/supabase/migrations supabase/migrations
npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,postgres-meta,supavisor,realtime,storage-api

# 2. build AND serve with the stack's own keys in the ENVIRONMENT.
#    `next build` inlines NEXT_PUBLIC_* into the Edge proxy, so a build made without them talks to
#    whatever .env.local names — see README, "Working on it".
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> npm run build
NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  RESEND_API_KEY=stub npx next start -p 3100

# 3. seed, sign in and measure
STACK_ANON_KEY=<anon> STACK_SERVICE_ROLE_KEY=<service> \
  npm run perf:floor -- --db-container supabase_db_<dir> --base-url http://localhost:3100 --runs 3
```

`--stack` defaults to `http://127.0.0.1:54321`, the CLI's own default; pass it when the stack was
started on other ports.

### Against a deployment (#185)

**A seeded preview** — the fixture on a real network. Steps 1 and 3's seeding as above, then:

```
# expose the stack; note the https://<words>.trycloudflare.com it prints
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:54321

# deploy the tree to measure as a PREVIEW, pointed at the tunnel, with mail sent nowhere
npx vercel deploy --yes --token <VERCEL_TOKEN> \
  --build-env NEXT_PUBLIC_SUPABASE_URL=<tunnel> --build-env NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> \
  --env NEXT_PUBLIC_SUPABASE_URL=<tunnel> --env NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon> \
  --env SUPABASE_SERVICE_ROLE_KEY=<service> --env RESEND_API_KEY=re_stub --env RESEND_BASE_URL=http://127.0.0.1:9

# previews sit behind Vercel's sign-in: the project's Protection Bypass for Automation secret
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> STACK_ANON_KEY=<anon> STACK_SERVICE_ROLE_KEY=<service> \
  npm run perf:floor -- --db-container supabase_db_<dir> --served-supabase-url <tunnel> \
  --base-url https://<preview>.vercel.app --runs 3
```

`--served-supabase-url` is needed because `@supabase/ssr` names its session cookie after the
Supabase host the *build* talks to, and that is the tunnel, not `127.0.0.1`. Run it from
PowerShell, or prefix Git Bash with `MSYS_NO_PATHCONV=1`: Git Bash rewrites a bare `/board` into
`C:/Program Files/Git/board`, which the runner refuses as not a path. The tunnel's own cost is
real — price it with a near-empty seed against production at the same volume, as arms P and Q
above do.

**The live project, read-only** — the re-run for when the club's real board has grown, which is
when this reading means most:

```
PERF_VIEWER_PASSWORD=<password> STACK_ANON_KEY=<live anon key> \
  npm run perf:floor -- --no-seed --stack https://<ref>.supabase.co --viewer <a crew account> \
  --base-url https://tender.madcowsailing.com --route /board --route /post/<an id>
```

`--no-seed` writes nothing, so it may name the live project; `--viewer` and `--route` are refused
on a seeded run, whose value is that it always measures the same viewer. A reading that names
either records `volume: null`, and the volume has to be stated beside it by hand. Use a rated crew
account that is not the club admin — the admin sees a heavier page.

Four guards, each proven able to refuse in `test/lighthouse-floor.test.ts` rather than merely
present:

- It **refuses a non-loopback Supabase URL on any run that seeds**, before writing anything. It
  seeds 80 people and 50 posts, which against the live project would be vandalism — the opposite
  shape from `check:live` and `verify:migrations`, which are read-only by construction. Only
  `--no-seed` may name the live project.
- It **refuses `--viewer` or `--route` on a seeded run**, so the fixture's number stays comparable
  across re-runs and the lighter-page defect `measuredViewer` fixed cannot come back by argument.
- It **refuses a run whose `finalDisplayedUrl` is not the URL asked for.** If the build picked up
  the wrong Supabase, the proxy 302s to `/join`, and `/join` is a small static form that **scores
  well**. The failure mode of this whole measurement is a reassuring number for a page nobody asked
  about.
- It **deletes each report path before the run that writes it**, so a run where Lighthouse writes
  nothing cannot be scored against the previous invocation's numbers.

`docs/performance-floor/summary.json` is the machine-readable form of the table above, written by
the same run. The full Lighthouse reports are ~3.7 MB for one pass and are deliberately not
committed; `--out <dir>` is where they land.
