# Tender

**Help pair skippers with crew.** The board that says who still needs a crew for Sunday.

At Hoover Sailing Club, crewed boats go short-handed or stay on the trailer most race days because
the skipper and a willing crew never found each other. Tender is a race-day board: a skipper posts
a need, the engine proposes crew by rung and tells them on their phones, someone taps *I can*, the
skipper accepts, and the board shows the match. Open to anyone who has learned to sail at Hoover,
member or not.

The decisions and their reasoning are in [`docs/charter.md`](docs/charter.md) (ratified
2026-08-21) and one ADR per architecture decision in [`docs/adr/`](docs/adr/). The idea's
pressure-test is [`forged-idea.md`](forged-idea.md). Read the charter before changing scope; it
carries the non-goals and the constraints a story must not violate.

## Non-goals (v1)

- No payments, fees or dues.
- No race management, results or scoring.
- No second club, no cross-club matching.

## Stack

| Decision | Choice | ADR |
|---|---|---|
| Language/runtime | TypeScript on Node 24 LTS | [001](docs/adr/001-typescript-on-node-lts.md) |
| Framework | Next.js 16 | [002](docs/adr/002-nextjs-16.md) |
| Data layer | Supabase Postgres via supabase-js, RLS, SQL migrations in `supabase/migrations/` | [003](docs/adr/003-supabase-js-rls-sql-migrations.md) |
| Hosting & scheduler | Vercel Hobby + Supabase Free; the ladder clock is pg_cron | [004](docs/adr/004-vercel-hobby-supabase-free-pg-cron-clock.md) |
| CI/CD & branches | GitHub Actions; `develop` (default) + `release` (production) + feature PRs | [005](docs/adr/005-branch-model-and-ci.md) |
| Testing | Vitest for the engine, pglite for RLS, jsdom for a click, Playwright smoke later | [006](docs/adr/006-testing-strategy.md), [008](docs/adr/008-interactive-component-tests-jsdom.md) |
| Notifications — the bet | Web push from an installed PWA + email to the current rung (Resend) | [007](docs/adr/007-notification-channel-the-bet.md) |

## Working on it

```
npm ci
npm run dev        # http://localhost:3000
npm test           # vitest: the engine (src/engine), the RLS harness (test/), the components
npm run lint
npm run typecheck
npm run check:live # read-only probe of the live Supabase project; needs .env.local
                   # first line: which of the 9 server env names THIS shell has (names only)
npm run migrate:live supabase/migrations/0015_anon_revoke.sql  # applies it; -- --dry-run rehearses
npm run verify:migrations # reads pg_catalog: is the live project in the state the files describe?
npm run icons     # re-render public/*.png from brand/hsc-mark-primary.svg (rarely)
npm run perf:floor -- --db-container supabase_db_<dir>  # ADR 002's kill condition, re-measured
npm run smoke -- --db-container supabase_db_<dir>       # the core path in a real browser (CI runs it on every PR)
```

Node 24 (`.nvmrc`). Copy `.env.example` to `.env.local` — names only are committed, never values.

**The engine** is `src/engine/ladder.ts`, a pure function: a post, a pool and a clock in; the open
rung and the candidates (each carrying their own rung) out. Its test is the scaffold's one real
test: six mutations on 2026-08-21 reddened exactly the predicted 3, 1, 2, 3, 1, 1 of 14
(`docs/adr/006-testing-strategy.md`).

**Installable to a home screen** (#28). `src/app/manifest.ts` is the manifest, `public/sw.js` the
service worker, and `src/install/` the "add to home screen" banner on /board. The worker is
**online only and has no listener for network requests** — a cached board would show a need that
has already been filled — and `test/service-worker.test.ts` enforces that. The icons under
`public/` are committed; `npm run icons` regenerates them and `test/manifest.test.ts` reads their
real pixel sizes back out of the PNG headers.

The served half of that — `/manifest.webmanifest` and the icons as a real build returns them —
is `test/manifest-served.test.ts`, which runs **only** when pointed at a running server, because
CI runs the tests before the build:

```
npm run build && npm start &
TENDER_BASE_URL=http://localhost:3000 npx vitest run test/manifest-served.test.ts
```

**`next build` bakes `NEXT_PUBLIC_*` into the proxy.** To run a production build against a local
Supabase stack, those variables must be set for the **build**, not just for `next start` — the
proxy runs in the Edge runtime, where they are inlined rather than read at runtime. Build without
them and `.env.local` supplies the live project instead, so every local session is refused and
/board redirects to /join with the cookie sitting right there (measured 2026-08-25 on #28).

**Component tests come in two kinds, and the split is deliberate.** Most `.test.tsx` files
render with `renderToStaticMarkup` and assert the HTML a member is served — no effect runs and
no event can be dispatched, which is enough for anything decided at render time. The two files
that assert what happens after a **click** (`src/auth/PasswordFields.test.tsx`,
`src/app/join/JoinForm.test.tsx`, both #100) opt into jsdom with a `// @vitest-environment`
docblock on their first line. It is per file on purpose: `vitest.config.ts` stays
`environment: "node"`, whose shape `test/harness-budget.test.ts` asserts for #78. Each of those
files declares the environment exactly ONCE — vitest reads that directive anywhere in a file,
comments included, so a docblock quoting it in full silently declares it a second time and the
real line can then be deleted with nothing going red (measured on #100).

**The RLS harness** (`test/pglite.ts`) applies `supabase/migrations/*.sql` to an in-memory
Postgres and runs SQL as `anon`, `authenticated` or `service_role`. Since #48 it reproduces
Supabase's default privileges for the first two before applying anything, so a "this role is shut
out" assertion is load-bearing rather than passing on a harness that never granted the role
anything. It deliberately does **not** reproduce them for `service_role`, which is what makes a
missing `grant … to service_role` redden here (that is why 0014 exists); the reasoning and the
measured cost of each choice are in that file's docstring.

What it still cannot see is a grant the live project holds that no migration makes and no default
explains — a hand `grant` in the SQL editor. `npm run check:live` is the instrument for that. It
probes with `limit=0` and by GET so it can never write, and since #48 it reports, per table and
per function, whether the public anon key could still reach it — failing the run if any could.

**Applying a migration** is `npm run migrate:live <file>` (#114), and it does one thing a paste
cannot: it proves the payload arrived. It embeds the file in a dollar-quoted literal, asks
*Postgres* for the length, byte count and md5 of what it received, compares those against the file
on disk, and refuses if they disagree — **before** applying anything. A file compared against
itself would prove nothing, and on this machine a clipboard really does re-encode a file: the
characters at risk are the ones inside `comment on … is '…'` literals, which persist into the
database as schema documentation. Every migration here carries some — `test/migrate-live.test.ts`
asserts 0015's byte count exceeds its character count, so the hazard stays reachable rather than
being a number in prose that ages.

It takes a **file** from `supabase/migrations/` and never SQL. That narrowing is the point: a
general "run this against production" command is what the token makes easy and what was
deliberately not built. `-- --dry-run` prints the plan and sends nothing, and needs no credential
at all. Note that `npm run` claims a `--dry-run` of its own, so both `-- --dry-run` and
`--dry-run` are honoured — a silently dropped flag here is a real apply somebody thinks is a
rehearsal, and an unknown flag is refused rather than ignored.

It needs `SUPABASE_ACCESS_TOKEN` in `.env.local` — a **personal access token** from the account
page, not a project key. It is **scoped by project and by permission**, and it must cover *this*
project and allow writes. *Measured 2026-08-31 across three tokens*: one scoped to another project
answered `403` to every tender endpoint; one scoped here but read-only read fine and answered
`25006` to every write; only the third could apply anything. `GET /v1/projects` returns exactly the
projects a token covers, which is the one call that tells the three apart — and a 403 from this API
says *privileges*, never *scope*, so the message does not point at the cause.

It is still the widest credential in `.env.local`, so `.env.example` says how to revoke it and
`test/migrate-live-scope.test.ts` refuses the name reaching a place it should not. The service-role
key is not an alternative: it authenticates to this project's own API and cannot run DDL. Deciding
to apply is still the owner's; this changes who can carry it out, and whether the result is
verifiable.

**Asking whether the migrations are in place** is `npm run verify:migrations` (#117), and it is a
different question from `check:live`'s. `check:live` probes as a client, over PostgREST, with the
anon key, so it can see tables and functions and nothing else — which leaves it blind to most of
what this repo's recent migrations do. It reads the same number either side of pasting `0011`
(three check constraints), `0014` (one grant), `0015` (revokes and default privileges) or `0009`'s
two triggers. This reads `pg_catalog` with the management token instead, so a grant, a constraint,
a trigger, an index and a row-level-security flag are all in view. Neither command can answer the
other's question and neither replaces the other.

Its expectations are **parsed out of `supabase/migrations/*.sql`**, never listed in the script.
That is the whole design rather than a convenience: a hand-written expectation has the same author
as the migration, on the same day, from the same understanding, so it certifies agreement rather
than presence — and agrees with itself in exactly the case the command exists for, which is the
migration somebody wrote and forgot to apply. Adding a migration needs no edit to the command; a
statement in a shape nobody has written before is **refused** rather than skipped, so a kind it
cannot read can never be silently unchecked.

Two things it deliberately does not claim. It never says a migration was *applied* — a revoke of a
privilege nobody held and an update matching no rows both leave the database in the asserted state
without the file ever running, so every verdict is about state, and the run prints that in as many
words. And it names the statements nothing can testify to rather than counting them as passes:
today that is three backfills in `0011`, a seed insert in `0005`, and `0015`'s sequence sweep,
which has no sequence to sweep because no file here creates one.

Every query goes with `read_only: true`, so the *platform* enforces that this command cannot
write. That matters because omitting the flag connects a write-capable token as `postgres` with the
transaction open for writing: without it, a command whose whole purpose is to look would inspect
production over a connection that could change it.

### The half of `0015` this project cannot reach (#118)

`0015` revokes `anon` from the default privileges on `public`, and it worked. `ALTER DEFAULT
PRIVILEGES` with no `FOR ROLE` alters the **current role's** defaults and nothing else, though, and
this project has two roles holding default ACLs on that schema. *Read 2026-09-01, read-only, from
`pg_default_acl`*:

| `defaclrole` | tables | sequences | functions |
|---|---|---|---|
| `postgres` | postgres, authenticated, service_role | postgres, authenticated, service_role | postgres, authenticated, service_role |
| `supabase_admin` | postgres, **anon**, authenticated, service_role | postgres, **anon**, authenticated, service_role | postgres, **anon**, authenticated, service_role |

So `0015` cleared `anon` from all three of `postgres`'s rows, sequences included, and could never
have touched `supabase_admin`'s. *(The issue that found this recorded the `postgres`/sequences row
as absent — "nothing to revoke, so nothing was stored". Measured, the row is there and reads like
its two neighbours. Whether that cell was a mis-reading or the row was written since is not
knowable from here; the reading above is the one that was taken.)*

**Nothing this repo can apply will narrow the `supabase_admin` rows.** *Measured the same day*:
`pg_has_role('postgres', 'supabase_admin', 'member')` is `false`, `usage` likewise, and `postgres`
is not a superuser on a Supabase project — so `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin …`
is refused whatever credential this project holds. Closing it is an owner or Supabase-support
action, not a migration. It is recorded rather than fixed, deliberately: a statement that
measurably does nothing is worse than an absent one, because it reads as cover.

It is **inert while it is inert**, which is not the same as safe. A default ACL governs only the
objects its own role goes on to create, and every object in `public` here is created by the
migrations, which run as `postgres`. A platform-installed extension landing in `public` is the
realistic way that stops being true — and the exposure would then be silent, since `0015`'s sweep
covers what existed when it ran.

That is why `verify:migrations` now asserts the premise as well as the statement: every table,
sequence and function in `public` must be owned by the role that owns the tables the migrations
created. It fails on an empty population rather than passing, so a reading of "nothing has the
wrong owner" cannot come from having read nothing. The table above is a dated observation and will
age; **the check is the part that stays current**, and a red on it means the sweep is owed a re-run
over whatever arrived.

## Branches and deploys

- `develop` is the default and integration branch. Feature branches → PR → `develop`.
- `release` is Vercel's production branch. **Merging into `develop` deploys nothing**; promoting
  `develop` → `release` is the deploy, and it is the owner's — after any new migration has been
  applied to the live project (`npm run migrate:live <file>`; see *Applying a migration*).
- `main` is the **backup branch**: a known-good working version to fall back to if `release`
  breaks and cannot be fixed in place. It is promoted **from `release`** by a pull request the
  owner merges — from the branch production actually ran, so the backup is by construction a
  state that has been live. It is never a base for new work, and a `main` that has moved is the
  backup being taken rather than drift. *(Owner directive 2026-09-01; supersedes ADR 005's
  "retired at scaffold" consequence.)*
- `githooks/pre-push` refuses direct pushes to `develop`, `main`, `master` and (via
  `githooks/owner-only`) `release`. Enable it once per clone: `git config core.hooksPath githooks`.
  It runs `githooks/checks` before any other push.

## Build stamp

Every page ends in a footer such as `Tender v0.1.0 · 3c7759e · feature/169-build-stamp · built
2026-09-19` (#169). It answers "is production on the new one yet?" from the page itself rather
than from the Vercel dashboard, which a member cannot see and the owner cannot see from the water.

- **`v0.1.0` is `package.json`'s `version`, and that field is the one place the number lives.**
  Bump it in the PR that warrants it — edit the field, or `npm version patch --no-git-tag-version`
  (the flag matters: the repo has no tags and the promotion flow is a PR, so a tag here would be
  a second, unread record of the same fact). Nothing else reads the field. Forgetting the bump
  degrades to "which commit", not "no information", because the next two parts change per build.
- **The commit** is `VERCEL_GIT_COMMIT_SHA` on Vercel and `git rev-parse` locally. Absent both, the
  stamp omits it rather than the build failing over a footer.
- **The branch** appears only off `release`, so a preview deployment cannot pass for production.
- **The date** is when `next build` evaluated `next.config.ts`, where all four are computed and
  inlined through `env`. They are baked into the bundle, not read at request time, so the stamp on
  a page is the stamp of the build serving it — a stale bundle cannot claim a newer one.

A build the config did not stamp — vitest, for one — prints *unstamped build* in words. An empty
footer would be indistinguishable from a page that has none.

## The performance floor

**`npm run perf:floor` re-measures ADR 002's kill condition** with the instrument that ADR names —
Lighthouse mobile, simulated throttling, against a production build served locally with a fixture
of 80 people, 45 race dates and 50 posts, signed in through a real session cookie. Method, the
current reading and the levers already priced are in
[`docs/performance-floor.md`](docs/performance-floor.md); the short version is that `/board` reads
**72** and `/post/[id]` reads **83** against a floor of 80, so the condition's *local* antecedent is
met — but the ADR says *on a mid-range Android*, and a local serve is known to under-read this page
shape by about eight points, so [ADR 002](docs/adr/002-nextjs-16.md) records the measurement and the
one run against `release` that would make it decisive.

It **writes** — 80 people, 45 dates, 50 posts — so it refuses any Supabase URL that is not
loopback before touching a row. It is the opposite shape from `check:live` and `verify:migrations`,
which are read-only by construction, and it says so rather than relying on the flag being passed.

Two traps it guards, both of which produce a *reassuring* number rather than an error:

- **`next build` inlines `NEXT_PUBLIC_*` into the Edge proxy**, so a build made without them
  pointed at the local stack silently talks to whatever `.env.local` names. `src/proxy.ts` then
  finds no valid session and 302s to `/join` — a small static form that scores *well*. The command
  fetches each route with the cookie before spending two minutes on it and refuses anything but a
  200, and refuses again afterwards if Lighthouse's own `finalDisplayedUrl` is not what was asked
  for.
- **A single Lighthouse run is not a measurement.** `/board`'s three runs span 72–78 and
  `/post/[id]`'s span 78–90 on identical builds, so the command reports every run beside the median
  and warns when a route's runs straddle the floor rather than letting a lucky median pass silently.
  That warning is not hypothetical: `/post/[id]` passes on its median of 83 with one run at 78.
- **A score is a score of a page, and these pages differ per viewer.** The command CHOOSES who signs
  in — rated, not the club admin, owner of an open post — because the first version took the first
  person in the fixture, who is unrated, and so measured a board with all 45 availability forms
  suppressed. It read 78 that way and 72 correctly.

Everything that decides an outcome is in `scripts/lighthouse-floor-core.mjs`, exercised by
`test/lighthouse-floor.test.ts` with no stack, no browser and no network — the same split as
`check-live.mjs` and `verify-migrations.mjs`.

## The smoke

**CI's `smoke` job drives the core path through a real browser on every pull request** (#45, ADR
006's "Playwright smoke later"): two people seeded pre-confirmed with `auth.admin.createUser`, each
signing in through `/join`; the crew marks a race day on `/board`; the skipper posts a need; the crew
answers "I can"; the skipper accepts. It then checks that the crew's phone reached the skipper
**only after** the acceptance: it is absent from the skipper's page before, raw HTML and flight
data included, and present after in the same read and in the contact panel. The job starts a local
Supabase stack from `supabase/migrations`, builds against it, and runs `npm run smoke`. It runs on
pull requests only, and `timeout-minutes: 8` cancels it red past AC 3's budget.
`test/smoke.test.ts` holds both of those lines.

Sign-in is by **password**, not the admin-generated magic link #45 was filed with. #99 removed the
magic link from the app, and an admin link could now reach a session only by injecting cookies
around the sign-in screen (owner decision, 2026-09-21).

To run it locally, start a stack in a scratch directory (never the checkout), build against it,
serve the build, then run the smoke with the same three variables set:

```
npx supabase init --force --with-intellij-settings=false --with-vscode-settings=false
rm -rf supabase/migrations && cp -r <tender>/supabase/migrations supabase/migrations
npx supabase start -x studio,imgproxy,edge-runtime,logflare,vector,postgres-meta,supavisor,realtime,storage-api,mailpit
# in the checkout, with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
# SUPABASE_SERVICE_ROLE_KEY set to the stack's printed values:
npm run build && npx next start -p 3145 &
npm run smoke -- --db-container supabase_db_<dir> --base-url http://localhost:3145
```

It **writes**: it deletes and re-creates its two users, their race day and their boat, so it refuses
any Supabase URL that is not loopback, and its npm script loads no `.env.local`. A re-run starts from
the state CI does. The browser is the machine's own Chrome through `playwright-core`
(`channel: "chrome"`): nothing is downloaded, and CI's Chrome is whatever `ubuntu-latest` ships,
so it is **not pinned**. On a red run it saves each person's page to `--out` (CI uploads it as the
`smoke-output` artifact) and names the step that broke. The steps after that one print as
*not reached*, never as failed.

What it cannot see:

- **Email.** CI sets no `RESEND_API_KEY`, so every send fails at transport construction and is
  caught: the log carries one `RESEND_API_KEY is not set` line each for the rung, answer and match
  notifications, which also shows each notify call was reached.
- **The hosted project's grants.** The stack is the CLI's image, whose default privileges differ
  from the live project's. That seam is `check:live`'s and #48's, not this job's.
- **Google sign-up, the invite gate, and the password reset.** Those are the other entrances to a
  session; this job exercises the one a returning member uses.

Everything that decides an outcome is in `scripts/smoke-core.mjs`, exercised with no stack and no
browser. The steps themselves were proven against a local stack by three mutations, each red at the
predicted step and nowhere earlier: the accept step deleted from the smoke, `acceptAnswer` never
calling `accept_answer()`, and the contact policy narrowed back to self-only.

## Owner runbook — the steps only the owner can do

1. **Create the Supabase project** (Free; region near Ohio). Then apply every
   `supabase/migrations/*.sql` — `npm run migrate:live <file>` per file once
   `SUPABASE_ACCESS_TOKEN` is set in step 2, or the SQL editor before it is. Either route uses the
   same order: numeric, except **0003 after 0004** (its functions call `is_admin()`,
   which 0004 creates). **The revoke files must be last** — 0015 and 0016 — which numeric order
   already gives you: they create nothing and only take privileges away from what the earlier
   files created, so a table applied after them keeps the platform's default grant to `anon` and
   the sweep never saw it. Until 0015 is
   applied, `npm run check:live` exits 1 and names what `anon` can still reach — on the live
   project as of 2026-08-30 that is `club`, `answer_counts()` and `accept_answer()`. Then seed
   the **club row** in the SQL editor — it is a row, not a migration, so `migrate:live` does not
   take it — which no migration seeds and without which
   `/api/join` answers a bare 500 and nobody can sign in (measured 2026-08-23 on the live project,
   whose `club` table was empty):

   ```sql
   insert into public.club (name, brand_disc, brand_mark, invite_code, admin_email)
     values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'CHANGEME', 'you@example.org');
   ```

   `admin_email` is yours: the person who signs in with that address becomes the admin
   (0009's trigger sets `person.is_admin` on their first sign-in, and on an existing person the
   moment the column is set), so `/admin` loads with no SQL run against `person`. The colours are
   the Hoover pair (`brand/`) — the club accepted them on 2026-08-22 (#11, `docs/charter.md`
   § Forge checks), which is why the seed carries them rather than the mark set's default green.
   **Changing them afterwards is `/admin/theme`, not an edit to this row** (#41): that screen
   previews the mark in the pair and shows the contrast, and `set_club_theme()` (0028) refuses a
   pair under 3:1 at save, which a hand `update` would not. The code is a placeholder you rotate
   from `/admin` once signed in.
   On a project whose club row already exists, set the address on it instead:

   ```sql
   update public.club set admin_email = 'you@example.org' returning admin_email;
   select display_name, is_admin from public.person where is_admin;  -- your row, once signed in
   ```

   **A paste is no longer the only route.** With `SUPABASE_ACCESS_TOKEN` in `.env.local`, a
   session can run `npm run migrate:live supabase/migrations/<file>.sql`, which verifies the
   payload the database received before applying it — see *Applying a migration* above. The
   ordering rules in this step still hold whichever route is used, because they are facts about
   the migrations rather than about the SQL editor. Deciding to apply remains the owner's.

   Put the URL, the anon key **and the service-role key** (`SUPABASE_SERVICE_ROLE_KEY`,
   server-only: the invite gate reads `club.invite_code` and creates auth users with it) in
   `.env.local`, and in Vercel's environment — **all three**: on 2026-08-23 Vercel carried only
   the two public names, and `/api/join` threw a bare 500 ("Something went wrong.") before it
   could read the club row.

   **That failure is no longer silent, and this step now has an instrument** (#65). Every server
   name below is read through `env()` in `src/lib/env.ts`, which throws `<NAME> is not set` —
   *measured* on a production build: a POST to `/api/join` with the service-role key absent logs
   `⨯ Error: SUPABASE_SERVICE_ROLE_KEY is not set` and answers a 500 whose body never carries the
   name. And **`npm run check:live` prints, as its first line, which of the nine server names the
   shell running it has** — `present` / `ABSENT`, names only and never values, so it is safe to
   paste into an issue on this public repo. It reports rather than refuses, because several of
   these are legitimately absent on a developer's machine.

   The list lives in `scripts/server-env.mjs` and `test/server-env.test.ts` holds it equal to what
   `src/` actually reads, so a tenth name cannot be added to the app and forgotten here. Four of
   the nine **degrade** instead of throwing (the VAPID pair, `CRON_SECRET`, `OWNER_EMAIL`) — they
   are on the report for exactly that reason: nothing else would ever tell you.
   Enable the **Cron** integration and confirm a job can be scheduled on this plan — ADR 004's
   kill condition; its fallback is named there.

   Then set the fields in the table below, under **Authentication → URL Configuration / Sign In**.
   They are listed because a field nobody sets stays at the vendor's default permanently, and a
   default leaves no wrong value to notice — Supabase ships **Site URL** as
   `http://localhost:3000`, which points every confirmation email it ever sends at the recipient's
   own machine. The last two share the *User Signups* block and its single **Save changes**
   button, and that block has already failed to persist a flip here (#12), so **reload and read
   each one back after saving**:

   | Field | Value |
   |---|---|
   | Site URL | `https://tender.madcowsailing.com` |
   | Redirect URLs | `https://tender.madcowsailing.com/**` and `http://localhost:3000/**` |
   | Allow new users to sign up | **ON** (since #70, 2026-08-23 — it read OFF until then, and was never actually in force: the toggle did not persist, #12/#50). Tender is still invite-only, but the refusal moved out of the dashboard: a Google sign-up has to be allowed to create the auth user, so `ensurePerson` deletes any new auth user that arrives with no attestation and no invite gate behind it — the Google sign-in route and `/auth/callback` both reach it that way (`src/auth/person.ts`). Switching this OFF breaks *Continue with Google* for new members. Its cost is **stray auth users**, which since #85 the invite gate handles — see below |
   | Allow manual linking | **ON** — *set and read back 2026-08-24 on #74; it had been OFF, the vendor default, since the project was created.* Without it *Link a Google account* on `/profile` cannot work, and a member whose Google address differs from the one they joined with has no way to be recognised. Detail, and how to check it, under **Google provider** below |

   Check it without the dashboard: `GET /auth/v1/settings` reports `disable_signup: false` and
   `external.google: true`, and a deliberately failing `GET /auth/v1/verify?token=x` redirects to
   `tender.madcowsailing.com` rather than to localhost.

   **Stray auth users need nothing from you** (#85). *Allow new users to sign up* being ON means
   the public anon key can mint an auth user against any address from any browser — no
   attestation, no name, no `person` row. On 2026-08-25 four of the project's five auth users
   were exactly that, one of them belonging to a person about to be invited. Such a user used to
   **block that address's first sign-up**: the gate saw the address was taken, dropped the name
   and attestation it had just collected, sent the link anyway, and `/auth/callback` deleted the
   user and answered *"that account is not linked to a member here"* — to somebody who had just
   typed the right invite code. It then self-healed, because the delete cleared the address, so
   the second attempt worked and there was nothing left to reproduce.

   Since #85 the gate stamps its own attestation onto an unattested existing user and carries on,
   so the first attempt works. A wrong code or an unticked box still reaches neither the lookup
   nor the write. Nothing to do here, and **no auth user needs deleting by hand any more**.

   Two things in that paragraph changed with #99, which removed the emailed link. There is no
   "sent the link anyway" any more, because there is no link: a sign-up creates the account,
   mints the person row and signs the member in on the spot. And an already-**attested** user is
   no longer left untouched and told nothing - it is somebody's account, so the sign-up answers
   *"You already have an account here - sign in with your password"* and puts them on the Sign in
   tab. That reveals the address is registered, deliberately: the caller has already typed this
   season's invite code, and the old generic sentence stopped being honest the moment no link was
   on its way to anybody.

   To clear the historical ones anyway — they are inert, this is tidiness rather than repair:

   ```sql
   -- auth users with no person row, no attestation, and older than a day. The age is what keeps
   -- a sign-up or a Google flow that is in progress right now out of the way: both are exactly
   -- this shape for the minute or two between the auth user appearing and the link being opened.
   delete from auth.users u
    where not exists (select 1 from public.person p where p.id = u.id)
      and (u.raw_user_meta_data ->> 'adult_attested_at') is null
      and u.created_at < now() - interval '1 day'
   returning u.email, u.created_at;
   ```

   **That endpoint does not report every setting, and the one it is silent about is the one this
   list exists for.** It returns exactly eight top-level keys — `external`, `disable_signup`,
   `mailer_autoconfirm`, `phone_autoconfirm`, `sms_provider`, `saml_enabled`,
   `saml_private_key_next_configured`, `passkeys_enabled` — which is `supabase/auth`'s whole
   `Settings` struct, field for field. **Manual linking is not among them.** *Measured 2026-08-24
   in both directions*: the key set is byte-identical with the setting off and with it on, so a
   silent response is not evidence that it is off — which is the reading that would otherwise look
   safe. Its check is below, and it is not an endpoint.

   The one machine-readable route is the **Management API**, not the project's own: `GET
   https://api.supabase.com/v1/projects/{ref}/config/auth` carries
   `security_manual_linking_enabled`. It needs a personal access token (`sbp_…`), which this app
   does not hold and should not — so it is a thing the owner can run, not a probe for
   `check:live`.

   **Google provider** (#70, moved to the ID-token flow by #173). In Google Cloud, one OAuth
   client of type *Web application* serves all three Google flows, and it needs **both** of these
   on it:

   - **Authorised JavaScript origins**: `https://tender.madcowsailing.com`, and
     `http://localhost:3000` for `next dev`. Sign-in and sign-up render Google Identity Services'
     button on our own page (`src/auth/GoogleButton.tsx`) and obtain the ID token there, and GIS
     refuses to render for an origin that is not listed — the browser console says
     *"The given origin is not allowed for the given client ID"* and the page shows no button.
   - **Authorised redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback`, still —
     the `/profile` link flow (#74) goes through it, and so does nothing else since #173.

   Its client id and secret go under **Authentication → Providers → Google** in Supabase, and
   the client id ALSO goes in the app's environment as **`NEXT_PUBLIC_GOOGLE_CLIENT_ID`**, in
   `.env.local` and in Vercel's — it is public (every page carries it), and it is what the button
   renders with. Unset, `/join` shows no Google option on either tab and nothing says why
   (`npm run check:live`'s first line does). Leave **Skip nonce checks** OFF on the provider
   (#70 left it off; #173 relies on it): the page hashes a fresh random nonce per render (SHA-256,
   hex) and hands the hash to GIS, the route sends the raw value with `signInWithIdToken`, and
   Supabase refuses a token whose nonce claim does not hash to it — measured, see #173.

   A member whose account the email gate created and who later signs in with a Google account
   carrying the same verified address is linked to the existing user by Supabase (automatic
   identity linking) — #70's AC 6 measured it on the redirect flow, #173's AC 4 on this one. **A
   different address is not linked**, which is what *Allow manual linking* below is for.

   **The gate pass is gone.** Until #173 a fifth server-only name, `GATE_PASS_SECRET`, signed a
   ten-minute cookie that carried a new member's name and attestation across the Google
   redirect to `/auth/callback`. The ID token now arrives in the same request as the form, so the
   sign-up route checks the code, exchanges the token and mints the person row in one step, and
   the cookie, the secret and the callback leg were all retired together. Remove the variable
   from Vercel; nothing reads it.

   **What a member sees at Google, flow by flow** (#77, #173). Google's screens name the
   **origin that asked** — for the redirect flow that is the root domain of the OAuth client's
   redirect URI, never the App name from consent-screen branding, which is why #77 measured
   *"Sign in to `<project-ref>.supabase.co`"* on every flow with every Google-side field correct
   (2026-08-23 and again 27 days on, byte-for-byte). Supabase documents it and warns it *"does not
   inspire trust"*; their remedy, a Custom Domain, is $10/month on a paid plan and outside the $0
   charter. #173 took the other route, and the three flows now differ:

   - **Sign in** and **Sign up** (`/join`, both tabs): the GIS popup, bound to our origin — it
     names `tender.madcowsailing.com` (and *Tender*, the App name, where the popup shows one).
     The exact heading text is recorded on #173.
   - **Link a Google account** (`/profile`): still the redirect through Supabase, because
     GoTrue's identity-link endpoint is redirect-only — `@supabase/auth-js` has no ID-token form
     of `linkIdentity`. So this one screen still says *"to continue to
     `<project-ref>.supabase.co`"*, and that is not a misconfiguration; a member linking is
     already signed in, which is why it was left. To look at it without granting anything,
     append `&prompt=consent` to a hand-built `/auth/v1/authorize?provider=google&redirect_to=…`
     URL — consent is remembered, so an ordinary attempt renders nothing — and press Cancel,
     never Continue.

   **Allow manual linking** (#74) — the table's fourth row, at **Authentication → Sign In /
   Providers → User Signups**, sitting directly under *Allow new users to sign up* and described
   there as *"Enable manual linking APIs for your project"*.

   Automatic linking only ever fires on a *matching verified email*, so a member who joined as
   `alice@club.org` and presses *Continue with Google* as `alice@gmail.com` is a stranger to
   Supabase: a fresh auth user, deleted at the callback. With this ON they can attach that Google
   account to the one they already have, from `/profile`, and keep one `auth.uid()` — which every
   RLS policy in the schema is keyed on. With it OFF,
   `GET /auth/v1/user/identities/authorize` answers **404 `manual_linking_disabled`**
   (`supabase/auth`'s `requireManualLinkingEnabled`) and the app says linking is not switched on
   for this club.

   **How to check it afterwards, given `/auth/v1/settings` cannot.** Sign in and press *Link a
   Google account* on `/profile`: it either sends you to Google (**on**) or returns to the profile
   saying *"Linking a Google account is not switched on for this club yet"* (**off**). That is a
   one-tap readout of a setting no endpoint reports, and it is deliberately a different sentence
   from every other refusal so the two can never be confused.
2. **Custom SMTP**: Supabase's built-in mailer sends 2 emails an hour to team members only
   (measured 2026-08-21). Point Auth → SMTP at Resend, sending from `tender.madcowsailing.com`;
   add Resend's DNS records in the Cloudflare zone. **And a Resend API key as `RESEND_API_KEY`**
   in `.env.local` and in Vercel's environment (server-only, a fourth name beside step 1's
   three — `GATE_PASS_SECRET` was a fifth until #173 retired it; the Google client id under the
   provider above is public, not server-only): since #23 the app sends the rung notifications itself, by Resend's REST API from
   `tender@tender.madcowsailing.com`, and without the key the notification step fails before
   any send — the post still stands, the failure goes to the function log, nobody is emailed
   (#65 is where a missing name becomes a startup error). Both kinds of mail share Resend Free's 100/day;
   the app stops at 95 of its own sends and leaves the rest for password resets. (That headroom
   was sized for magic links; #99 removed them, so what it now protects is the one screen that
   still emails anything - Forgot my password. The number is unchanged and is a recorded default,
   not a measurement.)
2b. **Web push keys** (#29). Run **`npm run vapid:keys`** and put the pair it prints in
   `.env.local` and in Vercel's environment (Production **and** Preview):
   `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` — a sixth and seventh name beside the
   five above, and the only public one in the set.

   Three things about them that are not obvious:

   - **The public one is inlined into the browser bundle at build time.** A deployment built
     before the variable was set will not have it however many times it is set afterwards —
     redeploy. `/profile` shows *"Push notifications are not set up for this club yet"* instead of
     the control when it is missing, which is the symptom to recognise.
   - **Rotating them silently switches notifications off for everybody.** A browser stores the
     public key inside the subscription it made, so a new pair makes every stored subscription
     undeliverable, and nothing tells the member. Generate once; rotate only if the private key
     has leaked, and expect to ask everyone to press the button again.
   - **Without them the app still emails.** `notifyRung` treats push as best-effort and logs one
     warning per send when the keys are absent (ADR 007's own fallback), so a missing key is a
     degradation rather than an outage — and it is silent apart from that line, which is why #65
     exists.

   **iPhones only offer push to an installed web app.** A crew who has not added Tender to their
   home screen will see the button and be refused by the browser; `/profile` says so in as many
   words. That is Apple's rule, not a bug, and it is why #28 shipped before this.
2c. **The ladder clock** (#26). Nothing calls `/api/ladder/tick` until this step is done, and a
   ladder that never steps down is silent rather than broken — no error, no email, a board that
   simply stays on rung 1. Five things, in this order:

   1. **Enable `pg_net`** — dashboard, Database → Extensions. *Measured 2026-09-01*: `pg_cron`
      is already installed on the live project (1.6.4, left behind by #12's probe) and `pg_net`
      is **not** (available at 0.20.4, never created). `0017` refuses to apply while that is
      true, deliberately: with a guard on `pg_cron` alone it would schedule a job that calls
      into a schema that does not exist, and step 5 below would still read correct.
   2. **Create the two Vault secrets** — Project Settings → Vault, or in the SQL editor. The
      names are fixed; `0017` reads them by name at every tick, so rotating either one later is
      an update to these rows and no migration at all.

      ```sql
      select vault.create_secret('https://tender.madcowsailing.com/api/ladder/tick', 'ladder_tick_url');
      select vault.create_secret('<the same value as CRON_SECRET>', 'ladder_tick_secret');
      ```

   3. **Apply `0017`** — `npm run migrate:live supabase/migrations/0017_ladder_tick_schedule.sql`,
      or paste it. Either way it goes after `0016`.
   4. **Set `CRON_SECRET`** — any long random string (`openssl rand -base64 32`), the same value
      as `ladder_tick_secret` above, in `.env.local` and in Vercel's environment. It is an
      eighth server-only name beside the seven in steps 1, 2 and 2b. **Unset refuses every
      call** (`src/auth/bearer.ts`), so a deployment that never got it is closed rather than
      open — and the symptom is a uniform 401 rather than a partial success. Vercel documents
      that it sends `Authorization: Bearer $CRON_SECRET` on its own cron invocations when that
      variable is set, which is why one name serves both clocks; #27's AC 5 is where that is
      measured rather than believed.
   5. **Confirm the job exists, and that it RUNS.** Two reads, not one:

      ```sql
      select jobname, schedule, active from cron.job;                    -- ladder-tick, */15 * * * *
      select status, return_message, end_time
        from cron.job_run_details order by start_time desc limit 5;      -- succeeded, within 15 min
      ```

      The first alone is the reassuring half. A job can be listed, active and correct while every
      run fails — that is the whole reason step 1 comes first — and `tick_run` (`0012`), which
      `/admin` renders as *last tick N min ago*, is the readout that does not depend on either
      query being run by hand.

   The daily half needs nothing here: `vercel.json` carries it, and Vercel picks it up on the next
   production deployment. Hobby allows one invocation a day at ±59 min, which is why `0 12 * * *`
   is a sweep rather than the clock — pg_cron is the clock, and this is what still fires if
   pg_cron wedges (ADR 004).

   **Is the daily sweep alive?** `/admin` prints *last daily sweep* beside the tick, with its UTC
   time (#145). That stamp is `tick_run.sweep_at` (`0019`), and it moves only on a request carrying
   Vercel's `x-vercel-cron-schedule` header, so pg_cron's quarter-hour ticks do not overwrite it.
   The function log cannot answer the question for long: Hobby keeps it for one hour. **Apply
   `0019` before promoting the `develop` that carries it.** Until then `/admin`'s read fails and
   prints *never* for both clocks, and the daily sweep's own write fails it with a 500.
   Confirm it after the first scheduled window:

   ```sql
   select last_at, sweep_at from public.tick_run;   -- sweep_at inside 12:00–13:00 UTC today
   ```

2d. **The race morning** (#37). The same tick asks every crew still merely *accepted* on a match
   for that day to confirm — a push if they have one, an email with a Confirm link — at the first
   quarter-hour on or after **06:00 America/New_York**, once (`match.reminded_at`). The crew's
   Confirm button and the skipper's *Sailed* / *Did not show* buttons call `set_match_status()`.
   All of it is `0021`. **Apply `0021` before promoting the `develop` that carries #37.** Until
   then a tap on any of the three buttons is refused (PGRST202, shown as one sentence) and the
   morning-of pass logs a read error and does nothing, while the ladder half still runs — neither
   failure is loud, which is why the order matters. Nothing to enable and no new secret.

2e. **Error email to the owner** (#43). `src/instrumentation.ts` is Next's server error hook, and
   it is the club's entire observability layer — the charter asks for "errors emailed to the
   owner; nothing else", Hobby has no email alerting, and it keeps the function log for **one
   hour**, so an error nobody reads inside that hour is an error nobody ever reads. Two things:

   1. **Set `OWNER_EMAIL`** — the address the reports go to, in Vercel's environment. A **ninth**
      server-only name beside the eight in steps 1, 2, 2b and 2c. Unset means no email at all:
      the report goes to the function log with `OWNER_EMAIL unset` on it and expires there in an
      hour, which is the same as silence. Nothing else breaks, so this failure is quiet by
      construction — the one to check for deliberately rather than wait to notice.
   2. **Apply `0025` before promoting the `develop` that carries #43.** It adds
      `notification_log.signature`, which is how "the same error again" is recognised across
      Vercel's several instances. Without it the deduplication read fails and the app degrades
      *quietly rather than loudly*: there is no 500 and no visible symptom, but the only window
      left is the one held in each running instance's memory, so a cold start or a second
      instance can send the same report again.

   What lands: one email per distinct error — its name and the **route template** it threw on,
   `TypeError /post/[id]` — at most once an hour, carrying the method, the path with **any query
   string removed** (a reset code, an invite code and `/auth/callback`'s PKCE code all live in
   one, and this text goes to an inbox), and the first 20 lines of the stack. It rides Resend on
   the same 100/day as everything else and stops at 95, like every other sender; past that the
   report goes to the function log instead and `notification_log` records an `error_skipped_cap`
   row.

   **What it cannot see**, so nobody hunts for it here: an error the app has already caught. Every
   `…Live` wrapper in `src/notify/live.ts` swallows its failure to a console line on purpose, and
   a swallowed error never throws out of the route, so it never reaches the hook. The same is true
   of anything that fails *before* the app runs — a bad deployment, a DNS mistake, Vercel itself.

   Confirm it after the first deployment by reading the log rather than waiting for a fault:

   ```sql
   select sent_at, kind, signature, error from public.notification_log
    where kind in ('error', 'error_skipped_cap') order by sent_at desc limit 5;
   ```

3. **Vercel**: import the repo, set the production branch to `release`, add the environment
   variables, turn on Deployment Protection → Standard Protection (previews carry the production
   Supabase host), add the domain `tender.madcowsailing.com` (CNAME per Vercel's per-project
   target).
4. **GitHub secrets** `SUPABASE_URL` and `SUPABASE_ANON_KEY` for `.github/workflows/keepalive.yml`,
   which reads the project once a week so Supabase Free never pauses it (7 idle days). GitHub
   disables scheduled workflows after 60 days of repo inactivity — check it in spring.
5. **`git config core.hooksPath githooks` in every clone.** `.git/` is not tracked, so this is
   per-machine and per-clone; an uninstalled hook produces no error and no output, and every
   symptom of its absence is an absence. Two things it does not do on its own:

   - **It fires on POSIX clones only if the executable bit is stored in the index.** Git skips a
     non-executable hook silently. `core.fileMode=false` on Windows means `chmod +x` never reaches
     the index there, so the bit is set deliberately with `git update-index --chmod=+x` and the
     check is `git ls-files -s githooks` reading `100755` — not `ls -l`, which on Windows answers
     about a bit git is ignoring in both directions.
   - **It is a local echo, not the wall.** `git push --no-verify` skips it, and this repo is public,
     so the branch rules that hold against every client are GitHub's ruleset, which the provisioning
     story sets up. The hook stops the habit; the ruleset stops the push.
6. **A member who wants out deletes themself** — *Leave the club* at the foot of `/profile` (#42,
   0027). Their profile, contact, availability, answers, messages, devices and suspension go; every
   match they were on stays as a row with that side null, shown as "former member", so the season's
   count is unchanged; their boats stay as ownerless names on the posts that already happened, and
   an open post of theirs stays on the board until its date passes (owner decision 2026-09-20).
   **Removing someone else** has no screen yet. `delete_person()` admits an admin, but the SQL
   editor is not a signed-in member, so from the dashboard the route is two statements in this
   order: `update public.notification_log set to_email = null where person_id = '<uuid>'`, then
   `delete from auth.users where id = '<uuid>'` — `person` cascades from the auth user and 0027's
   rules do the rest; the address goes first because `person_id` is already null afterwards. If a
   member's own deletion lands on `/join?deleted=partial`, their rows are gone and the auth user is
   not — delete it under Authentication → Users.

## Brand

`brand/` holds the mark set from the 2026-08-21 brand work. The four SVGs there are the
**Hoover-themed** pair (`#395FAC` / `#FCCF0B`); the default-green exports the brand README's
table names were never exported. The component that was `brand/TenderMark.jsx` is
`src/brand/TenderMark.tsx` since #41 — typed, inside `tsconfig`, one copy — and its contrast
rule is `src/brand/contrast.ts`, with the same rule spelled in SQL by `set_club_theme()` (0028)
so it holds at save. Inline the component — never `<img src>` an SVG that uses the page's
colours. The app's pair is the **club row's** (`brand_disc` / `brand_mark`): the root layout
reads it on every request and sets `--brand-disc` / `--brand-mark`, the viewport and the manifest
from it, and the admin changes it on `/admin/theme`.
