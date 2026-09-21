# Performance floor — the board and post pages

What ADR 002's kill condition reads today, how it was measured, and which levers were priced
against it. Story #44.

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

The deciding measurement is the same command against the deployed `release` build. Until then this
records that the kill condition's local antecedent is met, not that the framework decision is due.

Two further things argue for care, both recorded because they cut against the finding:

1. **`/post/[id]` passes at 83 on the same 455 KB runtime** — the runtime does not sink a page on
   its own; it sinks a page that also pays a long render. But its runs straddle the floor, so it is
   not a comfortable pass either.
2. **The instrument is noisy.** `/board`'s three runs span 72–78 and `/post/[id]`'s span 78–90, on
   identical builds. A median of three is what the AC asks for; it is thin for this spread, which
   is why every individual run is printed beside its median and why `verdict()` raises a warning
   when a route's runs straddle the floor.

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

Three guards, each proven able to refuse in `test/lighthouse-floor.test.ts` rather than merely
present:

- It **refuses a non-loopback Supabase URL** before writing anything. It seeds 80 people and 50
  posts, which against the live project would be vandalism — the opposite shape from `check:live`
  and `verify:migrations`, which are read-only by construction.
- It **refuses a run whose `finalDisplayedUrl` is not the URL asked for.** If the build picked up
  the wrong Supabase, the proxy 302s to `/join`, and `/join` is a small static form that **scores
  well**. The failure mode of this whole measurement is a reassuring number for a page nobody asked
  about.
- It **deletes each report path before the run that writes it**, so a run where Lighthouse writes
  nothing cannot be scored against the previous invocation's numbers.

`docs/performance-floor/summary.json` is the machine-readable form of the table above, written by
the same run. The full Lighthouse reports are ~3.7 MB for one pass and are deliberately not
committed; `--out <dir>` is where they land.
