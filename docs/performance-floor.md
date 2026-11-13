# Performance floor — the board and post pages

What `/board` and `/post/[id]` read against the floors, how it was measured, and which levers were
priced against them. Story #44 took the local reading; story #185 took the deployed one —
**jump to [The deployed reading, 2026-09-22](#the-deployed-reading-2026-09-22--story-185)**.
Story #216 added a `devtools` throttling mode and took the repo's first reading with it,
[a different instrument from every other row here](#the-devtools-reading-2026-09-22--story-216).
Story #215 asked which metrics a member's phone can report see the board's hydration cost at all:
[Which field metrics can see the cost](#which-field-metrics-can-see-the-cost-2026-11-12--story-215).

**The floors price levers; they do not decide the framework.** The performance floor of 80 began
as ADR 002's lab kill condition, which fired on #185's deployed reading. On 2026-09-22 the owner
stayed on Next.js 16 and retired that condition as the framework trigger (#213). ADR 002's
framework trigger is now field data from members' phones, which `perf:floor` does not read — see
[What this means for ADR 002](#what-this-means-for-adr-002). A failing floor is a lever to price.

Re-run it with `npm run perf:floor` (see *Running it* at the foot). The command is the record's
instrument, not a convenience: a reading nobody can re-run is a sentence, not a measurement.

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
| document cut by 71% (10 dates instead of 45) | **none** under `simulate` only — see below |
| both client components removed entirely | **none** |

**The document-size "none" is a `simulate`-only finding.** `simulate` prices bytes, not CPU: it
replays an unthrottled trace under a network model and barely models the main thread, while
hydration cost grows with the rendered tree. Under `devtools` throttling, which really slows the
CPU, the same cut (45 → 10 dates, 710 → 280 DOM nodes) moved `/board` **66 → 73** and TBT
1.08 → 0.71 s, in the 2026-09-22 forge session that followed #185. That reading has not yet been
re-run by this repo's harness. Read the lever as worth nothing to the simulated score and worth
points to a real CPU.

Those three arms were measured **before** the viewer defect above was found, so their absolute
numbers (75 → 78, then 78, then 77) are from the lighter page and are not comparable with the 72 in
the table. They remain comparable **with each other**, which is what a lever arm is for, and the
framework-JS arm has since been re-measured on the correct page at 96 — so the shape of the
conclusion is unchanged. What each settled:

- **Prefetch was real but small.** The board carries a `<Link>` per post and Next prefetched every
  one; each prefetch is a full server render of a `force-dynamic` page against Supabase. It is kept
  for a second reason that has nothing to do with Lighthouse: a 50-post board was firing ~50
  dynamic server renders per view on Vercel Hobby and a free-tier Supabase.
- **Document size is not the lever *under `simulate`*.** Cutting 84 KB of HTML — 71% — moved the
  simulated median by nothing. It was the intuitive candidate and the arm is recorded rather than
  dropped. The qualifier matters: under `devtools` the same cut is worth points (see the note under
  the lever table above).
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

**Fixed by #217 (2026-09-23), measured on `develop` at `3d18318` plus #217's change.** The banner
is now a sheet fixed to the bottom of the screen, above the phone's docked navigation, so its
arrival moves nothing. Under `devtools` throttling, where the shift reproduces every time, `develop`
read 0.123 on `main > ol` in 3 of 3 runs and #217 read 0 in 3 of 3, with the banner on screen in
both (Lighthouse's final screenshots). See *The install banner, 2026-09-23 — story #217* below.

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
footer is its own story. *(That story is #211. It shipped a different rule, measured in* The
footer fix, 2026-09-23 *below.)*

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

## The devtools reading, 2026-09-22 — story #216

**A different instrument from every row above.** Every other reading in this document is
`simulate`. This one is `devtools`: the network and a 4× CPU slowdown were really applied. Do not
compare its numbers with a `simulate` row. See *Throttling* under *Running it*.

`npm run perf:floor -- --throttling-method devtools --runs 3`, seeded, on #44's fixture (80
people, 45 dates, 50 posts, 30 matches, 1,125 availability). It ran against `next build` +
`next start` of `develop` at **`beea286`** on localhost, with the local stack running beside it,
at 22:07–22:09 EDT. **#211's footer fix is not in this build.** Lighthouse 12.8.2, mobile preset,
Chrome 153, every run shown. Machine-readable in
`docs/performance-floor/2026-09-22/local-fixture-devtools.json`.

| route | throttling | performance | LCP | TBT | CLS | benchmarkIndex | build | #211 fix |
|---|---|---|---|---|---|---|---|---|
| `/board` | `devtools` | **75** (75 / 79 / 75) | 2.4 s (2.42 / 2.18 / 2.41) | **0.71 s** (0.72 / 0.60 / 0.71) | 0.123 | **1,750** (1,883 / 1,750 / 1,678) | `beea286` | no |
| `/post/[id]` | `devtools` | **88** (88 / 86 / 90) | 2.0 s | 0.44 s (0.44 / 0.49 / 0.35) | 0.000 | 1,852 (1,852 / 1,915 / 1,750) | `beea286` | no |

Accessibility was 99 on `/board` and 100 on `/post/[id]`.

**It does not reproduce the 66 reading.** The forge session that followed #185 read `/board` at
66 (65 / 67 / 66) with TBT 1.08 s. That reading has not been re-run by this repo's harness, and
this run was the attempt. Its runs span 75–79, with TBT 0.60–0.72 s, so 66 and 1.08 s both fall
outside this run's spread. Two differences could account for it. Neither was isolated by an arm of
its own, so both are reasoned, not measured:

- **The host was faster than the band.** Median `benchmarkIndex` was 1,750 on `/board` and 1,852
  on `/post/[id]`, above the 920–1,680 band. The run printed the warning that says so, and
  `verdict.warnings` records it. The same 4× slowdown on a faster CPU leaves less blocking time, and
  TBT is where this run and the 66 reading differ most.
- **The serving path.** This was a local `next start`. The 66 reading's record describes a
  deployed preview reached through a tunnel. #185's `simulate` arms put that gap between level and
  about four points, on a different instrument.

So this row stands as the repo's own `devtools` reading of `develop` on this host. The 66 stays a
forge-session figure. A devtools re-run on a host inside the band, or a deployed preview, is what
would settle it.

**CLS on `/board` is the install banner, not the footer, in this run.** Lighthouse attributes
0.123 to `body > div#main > main > ol` in all three runs. That is the element the banner pushes
down (see *CLS is the install banner* above). `body > footer` shifts in one run of three (0.112).
Both fail the 0.1 floor. `/post/[id]` reads 0 in all three.

## The footer fix, 2026-09-23 — story #211

**Verdict: with #211, CLS is 0 in every run on both routes, and no run attributes a shift to
anything. The same harness on `develop` reads 0.112 on `/board` in all three runs, each one
`body > footer`.**

The fix is not R2's rule. R2 (`#main[data-frame] { min-height: 100svh }`, *The deployed reading*
above) holds every page's frame at a viewport tall, so a short page ends in blank space above its
footer. #211 instead hides the About links and the stamp while `loading.tsx`'s "Loading…" is
shown (`#main:has([data-loading]) ~ :is([data-about], footer[data-build-stamp])`). They are then
laid out for the first time under the page, and a box that did not exist in the previous frame is
not a shift. A loaded page is laid out exactly as before.

`npm run perf:floor -- --runs 3`, seeded, on #44's fixture (80 people, 45 dates, 50 posts, 30
matches, 1,125 availability). Both arms ran against `next build` + `next start` on localhost, with
one local stack and the same host, back to back. The control is a `git worktree` of `develop` at
`7a37325`, and #211 is the same commit plus the rule. Lighthouse 12.8.2, mobile preset, `simulate`
throttling, every run shown. Machine-readable in `docs/performance-floor/2026-09-23/`.

| arm | route | performance | accessibility | CLS | shifts attributed | LCP |
|---|---|---|---|---|---|---|
| `develop` (control) | `/board` | **67** (67 / 66 / 67) | 100 | **0.112** (0.112 / 0.112 / 0.112) | `body > footer` in 3 of 3 | 5.2 s |
| `develop` (control) | `/post/[id]` | **84** (77 / 86 / 84) | 100 | 0.000 (0.112 / 0 / 0) | `body > footer` in 1 of 3 | 4.3 s |
| #211 | `/board` | **73** (75 / 70 / 73) | 100 | **0.000** (0 / 0 / 0) | none | 5.3 s |
| #211 | `/post/[id]` | **82** (82 / 79 / 83) | 100 | **0.000** (0 / 0 / 0) | none | 4.5 s |

- **The footer's shift is gone, and the control shows it was there to remove.** 0.112 is the same
  size as #185's L arm (0.141) and inside its 0.066–0.141 band. `/post/[id]`'s control shows the
  race #185 described: the footer shifts only in a run whose first paint came before the page.
- **`/board` gained 6 points** (67 → 73), and every #211 run (70–75) is above every control run
  (66–67). R2 bought +4 on a deployed preview. So the direction agrees and the size is
  one reading. **`/post/[id]` shows no gain.** Its runs overlap (77–86 against 79–83), and its
  control median already had CLS 0.
- **`/board` stays below 80**, which is ADR 002's reading and not this story's. The remainder is
  the simulated LCP #185 attributed to the framework runtime.
- **The install banner's shift (#217) did not appear in any run of either arm.** This document
  records that shift as intermittent (*CLS is the install banner* above), so its absence here is
  not evidence about #217.

`test/footer-streaming.test.ts` holds the mechanism without Lighthouse. It paints the real
`loading.tsx` inside the real layout in Chrome, swaps a page in, and reads `layout-shift` entries.
With the rule there are no entries. With the rule stripped, a board-shaped page reads **0.1118 at
Lighthouse's 412 × 823**, the figure this harness read on `develop`, and 0.1437 at 360 × 640.
AC 2 is held in two places, and only one of them can see R2's cost. `test/surfaces.test.ts` reads
`/join`, `/support` and `/privacy` at 360 × 640. On each, the frame is exactly its `<main>` and the
About links start 24 px (the frame's padding) under the content. But all three render taller than
640 px there, so a viewport-tall frame stretches nothing, and adding R2's rule left all three green.
`test/footer-streaming.test.ts` makes the same reading on a page shorter than the screen, where R2's
rule reddens it: the frame must equal its `<main>`, and the stamp must end on the first screen.

## The install banner, 2026-09-23 — story #217

**Verdict: with #217 no run attributes a shift to `main > ol` or to the banner, and CLS is 0 in
all twelve runs. The same harness on `develop` reads 0.123 on `/board` in all three `devtools` runs,
each one `main > ol`.**

The banner is now a sheet fixed to the bottom of the screen, just above the docked navigation on a
phone (the owner's call at pickup, over reserving its space or rendering it below the list). A fixed
box displaces nothing, and with no advice nothing is rendered and nothing is reserved. While it
shows, the page gains room at its foot and a scroll padding the height of the sheet, so the last
race day scrolls clear of it and a control focused under it is scrolled above it.

`npm run perf:floor -- --runs 3`, seeded, on #44's fixture, under **both** throttling methods.
`simulate` alone could not have shown this fix. Its trace is unthrottled, so the banner lands before
first paint, and `develop` reads 0 there too. `devtools` is where #216 saw the shift in every run.
Both arms ran against `next build` + `next start` on localhost, on one stack and host, back to back.
The control is a `git worktree` of `develop` at `3d18318` (#211 merged), and #217 is the same commit
plus the change. Lighthouse 12.8.2, mobile preset, every run shown. Machine-readable in
`docs/performance-floor/2026-09-23/local-fixture-217*.json`.

| arm | throttling | route | performance | CLS | shifts attributed | benchmarkIndex |
|---|---|---|---|---|---|---|
| `develop` (control) | `devtools` | `/board` | **76** (76 / 80 / 75) | **0.123** (0.123 / 0.123 / 0.123) | `main > ol` in 3 of 3 | 1,723 |
| #217 | `devtools` | `/board` | **74** (75 / 74 / 73) | **0.000** (0 / 0 / 0) | none | 1,540 |
| `develop` (control) | `devtools` | `/post/[id]` | 87 (89 / 84 / 87) | 0.000 | none | 1,732 |
| #217 | `devtools` | `/post/[id]` | 84 (77 / 86 / 84) | 0.000 | none | 1,781 |
| `develop` (control) | `simulate` | `/board` | 76 (76 / 76 / 68) | 0.000 | none | 1,822 |
| #217 | `simulate` | `/board` | 77 (67 / 77 / 77) | 0.000 | none | 1,375 |
| `develop` (control) | `simulate` | `/post/[id]` | 85 (82 / 86 / 85) | 0.000 | none | 1,676 |
| #217 | `simulate` | `/post/[id]` | 84 (84 / 82 / 86) | 0.000 | none | 1,469 |

The #217 rows are the shipped build, which includes `DockHeight` (below). An earlier #217 build
without it read the same CLS, 0 in all twelve runs, and `/board` under `devtools` at 81 (81 / 81 /
73).

- **The banner was on screen in both `devtools` arms.** Lighthouse's final screenshot shows
  `browser-prompt` above the race days on `develop` and as the bottom sheet on #217. So the 0 is a
  reading with the banner present, not a run where `beforeinstallprompt` never fired.
- **Performance is not claimed.** `/board`'s `devtools` median read 81 on one #217 build and 74 on
  the next, against the control's 76. That is the instrument's spread on this host, not a
  difference between the arms, and the medians straddle the floor. The CLS column is the result.
- **The docked navigation is not always 56 px, and the sheet sits on its measured height.** CI's
  first run of #217's test failed at 320 px: on the runner's fonts the nav wrapped to two rows
  (104 px), and a sheet offset by a fixed 3.5rem sat on it. *Measured* locally too: 104 px with the
  Admin link at 360 px or narrower, and 69–129 px at 125% text. `src/shell/dock.ts` measures it
  after hydration into `--dock`, which the sheet and the body's bottom padding both read. The
  padding had been a fixed 3.5rem since #154, so on a wrapped nav every page's last lines ended
  behind it. That is fixed by the same variable.
- **So is the sheet's own height.** CI's second run failed on the room the page makes for the
  sheet. That had been a fixed 12rem, and the runner's fonts set the iOS wording at 244 px at 125%
  text on 360 px. `src/install/sheet.ts` now measures the sheet into `--install-sheet`, and 12rem
  is only the pre-measurement fallback. The sheet is also capped at half the screen above the nav,
  with its wording scrolling inside it (the owner's call). At 150% text on a 320 × 640 phone, the
  iOS wording otherwise reached 436 px and left the race days 38 px.
- **The Lighthouse rows predate the last two changes** (the measured sheet and the cap). At
  Lighthouse's 412 × 823 the sheet is 128 px against a 383 px cap, so the cap does not bind. The
  measurement only changes the page's foot padding, which moves nothing on screen.
- **`simulate` read 0 on `develop` as well**, which is why it cannot be this story's evidence.
  It is recorded because it is the ADR's instrument, and #217 did not move it.

`test/install-sheet.test.ts` holds the mechanism in Chrome. It inserts the real banner markup,
both wordings, after the board's heading at 320, 360 and 412 px. With the sheet there are no shift
entries. With the placement rule stripped, the list shifts 0.13–0.19. The same file holds the sheet
clear of the navigation, both actions on top and at least 44 px, the foot and a Tab-focused covered
control clear of it, and, with no advice, a board with nothing reserved. It covers a one-row nav and
the wrapped ones (the Admin link at 320 and 360 px, 125% text) by running the real `watchDock` in
the page, and it checks the unmeasured fallback against a one-row nav.

## The board's window, 2026-11-11 — story #214

**No reading was taken for this story.** It changes what the measured `/board` is, so every
reading above this heading is of a different page from every reading after it.

- The default board lists only the dates still to sail. The fixture puts five of its 45 dates
  behind the anchor, so the measured page now renders **40 day rows**, plus one line above the
  list, "Show the whole season (5 already sailed)".
- `summary.json` still records `volume.dates: 45`. That is the fixture's size, not the number of
  rows on the page.
- The five rows that left are the lightest on the page: every fixture post sits on an upcoming
  date, so each lost a heading, a count and a disabled button. *Reasoned, not measured*: the lever
  table above prices a much larger cut (45 dates to 10) at no change under `simulate` and at seven
  points under `devtools`, so this one should move the score by nothing or by about a point.
- The disabled "Already sailed" button is no longer on the measured page. Lighthouse's
  accessibility reading of `/board` therefore no longer covers it. `test/surfaces.test.ts` reads
  that button in the full-season view, for contrast and under axe.

## Which field metrics can see the cost, 2026-11-12 — story #215

**A different instrument again, and a different question.** ADR 002's framework trigger is field
data from members' phones, against thresholds written before any data exists. The cost that fired
the lab condition is hydration, which Lighthouse reads as Total Blocking Time, and no phone reports
TBT. So before a threshold names a metric, this asks which metrics a phone *can* report move at all
when the board gets shorter.

`npm run perf:field` (see *Running it*) loads `/board` in Chrome with the CPU slowed 4×, taps the
first day's availability toggle at a fixed time after navigation start, and reads what Next's own
`web-vitals` attribution build reports: LCP, INP with its three phases, and the blocking time of
long animation frames (LoAF). It does that on two boards that differ only in their length:

| board | fixture dates | day rows on the page | elements | hydrated at 4× | long-frame blocking, unslowed | at 4× |
|---|---|---|---|---|---|---|
| larger | 45 (5 sailed) | **40** | 681 | 677 ms | 0 ms | 208 ms |
| smaller | 15 (5 sailed) | **10** | 351 | 657 ms | 0 ms | 168 ms |

Both carry the same 80 people, 30 boats, 50 posts, 30 matches and 75 answers, and 1,126 and 1,125
availability rows. Unslowed, either board hydrates at about 170 ms, or at about 420 ms: single
loads come in those two groups, on both boards, and none shows a long frame.

The issue was written when the board rendered all 45 dates. Since #214 the default board hides the
five already sailed, so the arms are 40 rows against 10 (owner decision at pickup: measure the
page a member lands on, not the full-season view).

**A metric is said to see the cost only if the larger board's median is above the smaller board's
by more than the run-to-run spread** (largest run minus smallest) of whichever board's runs were
further apart. Five runs of each board at each tap time, interleaved. Every other metric is
labelled as unable to see it.

### The finding

**At 4× on this machine, no metric tells the two boards apart.** In the pass of record every
metric is labelled as unable to see the cost. The command was run five times, and the one metric
that came close crossed the bar in three of them and missed it in two, the pass of record among
them.

- **LCP cannot see it**, at either tap time, in any pass.
- **INP sees hydration, and cannot tell the boards apart.** A tap during hydration read 176–320 ms
  on either board, and a tap after it read 8–48 ms on either board. So INP moves by about 200 ms
  when a member taps while the page is still hydrating, whichever board it is. Between the boards
  its median differed by much less than that, and by less than the spread in most passes.
- **A tap after hydration separates nothing.** INP's delta was 0 ms in all five passes.
- **LoAF blocking time is the nearest thing to a metric that sees it**: 39–59 ms more on the larger
  board with the early tap, above the spread in three passes of five. Only Chromium reports it, so
  no iPhone and no Firefox would.
- **At 8× the gap grows and the answer does not change.** LoAF blocking is 93–167 ms worse on the
  larger board there, and clears the spread in three of six readings. INP and LCP still do not
  separate the boards.

**So the thresholds question goes back to the owner, and no metric is picked here.** Of the three
a threshold could name, one cannot see the cost at all, one sees hydration but not the board's
length, and the one that comes closest is unreliable at five runs and blind on every iPhone.

### The pass of record

Taken 2026-11-12 21:05–21:08 EST against `next build` + `next start` of `develop` at `769be42`
(this story changes no app code), on localhost with the local stack beside it. Chrome 157, the
viewport of Lighthouse's mobile preset (412 × 823), CPU slowed 4× with
`Emulation.setCPUThrottlingRate`, network not throttled, cold cache every run. Machine-readable in
`docs/performance-floor/2026-11-12/field-vitals.json`. Median, then every run. Times in ms.

**Tap at 450 ms**, which landed before hydration finished in 10 of 10 runs (hydration finished at
711 ms and 670 ms, medians). INP's largest phase was input delay in all ten.

| metric | 45 dates (40 rows) | 15 dates (10 rows) | delta | spread | label |
|---|---|---|---|---|---|
| LCP | 200 (220 / 196 / 188 / 200 / 616) | 184 (184 / 172 / 180 / 192 / 188) | 16 | 428 | cannot see it |
| INP | 248 (272 / 248 / 216 / 240 / 288) | 208 (208 / 208 / 216 / 192 / 216) | 40 | 72 | cannot see it |
| INP input delay | 194 (252 / 189 / 194 / 180 / 271) | 158 (183 / 163 / 158 / 141 / 155) | 36 | 91 | cannot see it |
| INP processing | 16 (16 / 55 / 14 / 60 / 16) | 47 (18 / 40 / 52 / 47 / 60) | −32 | 46 | cannot see it |
| INP presentation delay | 4 (4 / 4 / 8 / 0 / 2) | 5 (7 / 5 / 6 / 4 / 2) | −1 | 8 | cannot see it |
| LoAF blocking, whole run | 207 (207 / 207 / 180 / 209 / 251) | 169 (182 / 139 / 169 / 155 / 192) | 39 | 71 | cannot see it |
| LoAF blocking, before the tap | 178 (106 / 185 / 153 / 178 / 191) | 154 (154 / 126 / 155 / 140 / 169) | 24 | 85 | cannot see it |
| FCP | 200 (220 / 196 / 188 / 200 / 204) | 184 (184 / 172 / 180 / 192 / 188) | 16 | 32 | cannot see it |
| TTFB | 38 | 39 | −1 | 6 | cannot see it |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 | cannot see it |

**Tap at 4,000 ms**, after hydration in 10 of 10 runs.

| metric | 45 dates (40 rows) | 15 dates (10 rows) | delta | spread | label |
|---|---|---|---|---|---|
| LCP | 608 (608 / 604 / 620 / 604 / 636) | 584 (600 / 656 / 584 / 580 / 576) | 24 | 80 | cannot see it |
| INP | 40 (40 / 40 / 40 / 40 / 40) | 40 (8 / 40 / 40 / 40 / 40) | 0 | 32 | cannot see it |
| INP input delay | 13 (13 / 13 / 13 / 13 / 13) | 13 (6 / 13 / 13 / 13 / 13) | 0 | 8 | cannot see it |
| INP processing | 18 (19 / 16 / 21 / 18 / 18) | 17 (0 / 16 / 17 / 17 / 19) | 2 | 19 | cannot see it |
| INP presentation delay | 9 (8 / 11 / 7 / 9 / 9) | 10 (2 / 11 / 10 / 11 / 7) | −2 | 9 | cannot see it |
| LoAF blocking, whole run | 214 (185 / 190 / 225 / 214 / 243) | 168 (189 / 164 / 169 / 167 / 168) | 47 | 58 | cannot see it |
| LoAF blocking, before the tap | 156 (145 / 151 / 178 / 156 / 196) | 146 (166 / 138 / 148 / 146 / 146) | 10 | 52 | cannot see it |
| FCP | 184 (184 / 192 / 180 / 184 / 196) | 176 (176 / 176 / 172 / 184 / 176) | 8 | 16 | cannot see it |
| TTFB | 39 | 38 | 2 | 5 | cannot see it |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 | cannot see it |

The tap took the day back as a client-side transition in all 20 runs. None was a plain form post,
so React was already listening at 450 ms and held the tap until it had hydrated the form.

### The labels did not hold from pass to pass

The command was run five times that evening, 20 runs each, on the same build, between 20:44 and
21:08 EST. The pass of record is the fifth: the only one taken with the command exactly as
committed, and named as the record before it ran. The earlier passes measure a run the same way.
What changed between them is what the command checks around the runs (how it proves the CPU was
slowed, and how it reports what saw the cost). Passes 2 to 4 are committed beside the record as
`field-vitals-pass-2.json` to `-pass-4.json`; their `boards` entries carry an older form of the
unslowed reading. Pass 1 predates the summary's shape and is not committed. Each cell is the delta
over the spread, bold where the metric was labelled as seeing the cost.

| metric, tap at 450 ms | pass 1 | pass 2 | pass 3 | pass 4 | pass 5 (record) | saw it |
|---|---|---|---|---|---|---|
| INP | 32 / 96 | **80 / 56** | 56 / 64 | 72 / 72 | 40 / 72 | 1 of 5 |
| INP input delay | 25 / 80 | **84 / 72** | 20 / 98 | 26 / 93 | 36 / 91 | 1 of 5 |
| LoAF blocking, whole run | **56 / 43** | **59 / 52** | 55 / 76 | **43 / 42** | 39 / 71 | 3 of 5 |
| LoAF blocking, before the tap | 49 / 54 | **52 / 33** | 33 / 82 | 15 / 82 | 24 / 85 | 1 of 5 |
| LCP | −8 / 36 | 16 / 464 | 16 / 440 | 32 / 432 | 16 / 428 | 0 of 5 |

With the tap at 4,000 ms no metric saw the cost in any pass: INP's delta was 0 in all five, and
LoAF blocking's was 39, 22, 32, 58 and 47 against spreads of 64, 70, 51, 59 and 58.

The medians point the same way every time: the larger board is 39–59 ms worse on LoAF blocking and
32–80 ms worse on an early tap's INP. What changes from pass to pass is the spread, which is as
large as the gap. A rule that needs the gap to clear the spread therefore flips with five runs. That
is the result, not a fault in the rule: on this machine the two boards are about 50 ms of main-thread
time apart, and one run differs from the next by that much.

### The same boards at 8×, three passes

A slower phone stretches hydration, so the command was run three more times at 8×, between 21:08
and 21:24 EST, with the taps moved to match (`--cpu-rate 8 --tap-at 1200 --tap-at 8000 --settle
6000`). The page hydrated at about 1.6 s and 1.5 s there, and the early tap landed before that in
30 of 30 runs. Machine-readable in `field-vitals-8x.json`, `-8x-pass-2.json` and
`-8x-pass-3.json`. The first pass, as median and range:

| metric | tap | 45 dates (40 rows) | 15 dates (10 rows) | delta | spread | label |
|---|---|---|---|---|---|---|
| LoAF blocking, whole run | 1,200 ms | 967 (917–1,030) | 826 (746–869) | 141 | 123 | **sees the cost** |
| LoAF blocking, whole run | 8,000 ms | 807 (784–872) | 673 (654–724) | 135 | 87 | **sees the cost** |
| LoAF blocking, before the tap | 8,000 ms | 591 (571–607) | 533 (527–570) | 59 | 42 | **sees the cost** |
| INP | 1,200 ms | 408 (360–560) | 320 (272–384) | 88 | 200 | cannot see it |
| INP | 8,000 ms | 80 (72–80) | 80 (72–80) | 0 | 8 | cannot see it |
| LCP | 1,200 ms | 1,252 (1,240–1,420) | 1,168 (428–1,228) | 84 | 800 | cannot see it |
| LCP | 8,000 ms | 1,272 (1,248–1,316) | 1,192 (1,176–1,260) | 80 | 84 | cannot see it |

And all three, as delta over spread:

| metric | tap | pass 1 | pass 2 | pass 3 | saw it |
|---|---|---|---|---|---|
| LoAF blocking, whole run | 1,200 ms | **141 / 123** | 149 / 171 | 167 / 174 | 1 of 3 |
| LoAF blocking, whole run | 8,000 ms | **135 / 87** | 93 / 146 | **107 / 83** | 2 of 3 |
| LoAF blocking, before the tap | 1,200 ms | 49 / 115 | 84 / 129 | 58 / 137 | 0 of 3 |
| LoAF blocking, before the tap | 8,000 ms | **59 / 42** | 21 / 153 | 31 / 68 | 1 of 3 |
| INP | 1,200 ms | 88 / 200 | 64 / 112 | 104 / 184 | 0 of 3 |
| INP | 8,000 ms | 0 / 8 | 16 / 24 | 8 / 40 | 0 of 3 |
| LCP | 1,200 ms | 84 / 800 | 56 / 160 | 116 / 168 | 0 of 3 |
| LCP | 8,000 ms | 80 / 84 | 64 / 200 | 68 / 80 | 0 of 3 |

So at twice the slowdown the gap in long-frame blocking grows to 93–167 ms, and it still clears
the spread in only three of its six readings. INP and LCP do not separate the boards in any. INP
read 272–568 ms for a tap during hydration and 72–120 ms after it, on either board, the same shape
as at 4×. Its largest phase was processing in all thirty early taps, not input delay as at 4×. In
one run of sixty the library reported no element for the tap, though the tap had taken the day
back; the command counts such a run on that evidence.

### Why each metric reads as it does

- **LCP is painted before hydration matters.** With the late tap the board's content painted at
  608–628 ms on the larger board and 584–620 ms on the smaller (medians of the five passes).
  *Reasoned*: LCP is the server's HTML being painted, and React hydrating that HTML afterwards does
  not repaint it.
- **An early tap cuts LCP short.** LCP stops being measured at the first interaction. With the tap
  at 450 ms it read 172–224 ms in most runs, the shell's header, and 616–648 ms in the five runs
  of fifty where the content painted before the tap was handled. That is where the 428–464 ms
  spreads above come from. A member who taps early therefore reports a *lower* LCP, which is one more reason
  it cannot carry this threshold.
- **INP is the wait for the main thread.** With the early tap its largest phase was input delay in
  every run of every pass: the tap arrives, the page is busy hydrating, and the handler runs when it
  is done. The two boards finish hydrating about 40–70 ms apart (medians of 702–735 ms against
  646–681 ms), and that is the most INP could show.
- **INP's `loadState` does not mark these taps.** It read `complete` on all fifty early taps: on
  localhost the page's load event fires before hydration ends. A reporter could not use it to pick
  out taps made during hydration here.
- **Most of the hydration cost is not the rows.** Unslowed, neither board shows a long frame at
  all. At 4× both show 160–240 ms of LoAF blocking, and the 30 extra rows add about 50 ms of it. *Reasoned*: the rest is the framework's own start-up, which both boards pay and
  this comparison therefore cannot see. ADR 002's stay decision reads the same way from the lab side
  (a near-empty board still read 77).

### What this cannot tell you

- **It is this machine slowed 4×, not a phone.** The page hydrates in about 170 ms unslowed here,
  which is a fast desktop. Lighthouse read this host's `benchmarkIndex` at **3,474** that evening
  (one `perf:floor --throttling-method devtools` run at 21:15 EST, taken to check that command
  after this story moved its stack helpers), against the 920–1,680 band the 4× multiplier is
  calibrated for. *Reasoned*: a host about twice as fast as the band's top edge, slowed 8×, is
  roughly a band-edge host slowed 4×. So the 8× passes above are nearer to what "4×" is meant to
  describe than the 4× passes are, and a mid-range phone is slower still.
- **The network is not throttled.** Lighthouse's `devtools` mode throttles both, and read 0.71 s of
  TBT on this board on this host (#216). These numbers are not comparable with that row.
- **Nobody taps at 450 ms.** The early tap is a probe of what INP reads when an interaction lands in
  hydration, not a model of a member. On this machine that window closes at about 0.7 s.
- **It is Chrome.** The support table below says which of these a member's phone reports at all.
- **The instrument listens from the first byte.** A real reporter mounted by React starts after
  hydration and sees earlier entries only through the browser's buffer, so it can see no more than
  this and may see less.
- **Both boards read 1,000 availability rows, not 1,125.** The API caps one read at 1,000 rows
  (`max_rows`; *measured* on the local stack: 1,000 of 1,126 returned, 67 of 75 people). It is the
  same on both arms, so the comparison stands, but it is a defect in the board at this volume and is
  noted here because the command has to work around it (it writes the viewer's row first).

### Browser support, checked 2026-11-12

From MDN's browser-compat-data (the data behind MDN's compatibility tables), read that day, and
web.dev's Baseline announcement of 2025-12-17.

| metric | API | Android Chrome | iOS Safari | Firefox Android | source |
|---|---|---|---|---|---|
| LCP | `LargestContentfulPaint` | supported (77) | **partial**: supported from Safari 26.2 (2025-12-12), unsupported before | supported (122) | [MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/LargestContentfulPaint.json) |
| INP | Event Timing with `interactionId` | supported (96) | **partial**: supported from Safari 26.2, unsupported before | **partial**: supported from 144; 89–143 have Event Timing without `interactionId` | [MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/PerformanceEventTiming.json) |
| LoAF blocking | `PerformanceLongAnimationFrameTiming` | supported (123) | **unsupported** | **unsupported** | [MDN data](https://github.com/mdn/browser-compat-data/blob/main/api/PerformanceLongAnimationFrameTiming.json) |

Two things the table needs beside it, both from
[web.dev](https://web.dev/blog/lcp-and-inp-are-now-baseline-newly-available): every browser on iOS
is WebKit, Chrome included, so an iPhone below iOS 26.2 reports neither LCP nor INP whatever the
member installed; and Safari and Firefox time LCP and INP to a slightly earlier point in the frame
than Chrome does, a few milliseconds apart. *Not measured here*: none of these numbers was taken on
Safari or Firefox.

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

### Throttling: `simulate` or `devtools` (#216)

`--throttling-method` takes `simulate` (the default, and what every reading before #216 used) or
`devtools`. Any other value is refused before anything is seeded or launched.

```
STACK_ANON_KEY=<anon> STACK_SERVICE_ROLE_KEY=<service> \
  npm run perf:floor -- --db-container supabase_db_<dir> --throttling-method devtools --runs 3
```

The two read similar scores for different reasons, so **a row from one is never comparable with a
row from the other**:

- **`simulate`** records an unthrottled trace and replays it under a slow-4G model. It prices
  **bytes**. Hydration and layout barely register, so it cannot see a lever that saves CPU.
- **`devtools`** really throttles the network and slows the CPU 4×. Compressed bytes cross a
  throttled link, and hydration shows up as Total Blocking Time. This is the only mode in which the
  framework runtime's main-thread cost is visible at all.

**The `benchmarkIndex` caveat.** A `devtools` reading describes a mid-range phone only if the host
is a mid-range desktop, because the 4× slowdown is applied to whatever CPU ran it. Every report
carries `environment.benchmarkIndex`. The summary keeps each run's value and the per-route median,
and prints a warning (also recorded in `summary.json`'s `verdict.warnings`) when a `devtools`
route's median falls outside **920–1,680**, the band that slowdown is calibrated for. Outside it the
TBT column describes some other phone. A running Docker stack is itself contention and moves the
index, so read it from the run rather than assuming the machine's usual figure. `simulate` runs are
not judged against the band.

Each route's `throttlingMethod` in `summary.json` is the method Lighthouse **reports** having used,
read from the report, not from the flag.

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

Five guards, each proven able to refuse in `test/lighthouse-floor.test.ts` rather than merely
present:

- It **refuses a `--throttling-method` other than `simulate` or `devtools`** before reading a key,
  seeding a row or launching Chrome (#216). Lighthouse accepts a third method, `provided`, which
  throttles nothing, so a typo it happened to accept would record an unthrottled run as a reading.

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

### Which field metrics see the cost: `perf:field` (#215)

Steps 1 and 2 as above (a local stack, and a build made and served with its keys). Then:

```
STACK_ANON_KEY=<anon> STACK_SERVICE_ROLE_KEY=<service> \
  npm run perf:field -- --db-container supabase_db_<dir> --base-url http://localhost:3100
```

It needs no `perf:floor` run first: it mints the same 80 people and seeds its own two boards. It
takes about four minutes for the default five rounds, and prints both boards' runs side by side
with a label per metric. `--out <dir>` (default `field-vitals`) receives `summary.json`, which is
what gets committed, and `runs.json`, every run's own record.

- `--runs <n>`: rounds, each one run of every board at every tap time. **Below five nothing is
  labelled** and the command exits 1, so a short run cannot report that no metric saw the cost.
- `--tap-at <ms>`, repeatable: when the toggle is tapped, from navigation start. The defaults, 450
  and 4,000, are tuned to the owner's machine at 4×: the first lands during hydration and the
  second after it. Each run records where its own tap fell, so read the "before hydration / after
  hydration" counts in the report before reading anything else.
- `--cpu-rate <n>` (default 4) and `--settle <ms>` (default 4,000, the quiet time after the tap).
  At another rate the tap times have to move with it: at 8× this page hydrates at about 1.5 s, and
  the passes above used `--cpu-rate 8 --tap-at 1200 --tap-at 8000 --settle 6000`.

Four guards, each proven able to refuse in `test/field-vitals.test.ts`:

- It **refuses a Supabase URL that is not loopback**, before minting or writing anything. Every run
  starts with `truncate table public.race_date cascade`, which empties the race dates and every
  table hanging off them (posts, availability, matches, answers, suggestions, messages, the
  notification log), so that every run reads the same rows in the same order.
- It **refuses a run that measured something else**: a board with the wrong number of day rows, a
  page that reported no LCP or no interaction, a tap that landed on anything but the first day's
  toggle, or a tap that did not take the day back. The command stops there, and the runs already
  taken are in `runs.json`.
- It **refuses a run set whose CPU was not visibly slowed.** Each board is also loaded three times
  unslowed, and the slowed runs' long frames must block for more than 1.5 times as long as those
  loads' did. A slowdown that silently failed to apply would otherwise read as "cannot see it".
- It **labels nothing from fewer than five runs** of either board.

Two things it does that a reader should know before trusting a number. **Every run reseeds**, and
the seed writes the viewer's availability for the tapped day *first*: the board's availability
read stops at 1,000 rows, and a row written after the other 1,125 is never shown. And **the
`web-vitals` build is Next's own compiled copy**, injected before the page's scripts, because
tender has no reporter yet. `test/field-vitals.test.ts` loads that file from `node_modules`, so an
upgrade of Next that moves or reshapes it reddens there.
