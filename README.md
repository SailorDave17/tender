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
npm run migrate:live supabase/migrations/0015_anon_revoke.sql  # applies it; -- --dry-run rehearses
npm run verify:migrations # reads pg_catalog: is the live project in the state the files describe?
npm run icons     # re-render public/*.png from brand/hsc-mark-primary.svg (rarely)
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
migration somebody wrote and forgot to paste. Adding a migration needs no edit to the command; a
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

## Branches and deploys

- `develop` is the default and integration branch. Feature branches → PR → `develop`.
- `release` is Vercel's production branch. **Merging into `develop` deploys nothing**; promoting
  `develop` → `release` is the deploy, and it is the owner's — after any new migration has been
  pasted into the live project.
- `main` is the **backup branch**: a known-good working version to fall back to if `release`
  breaks and cannot be fixed in place. It is promoted from `develop` by a pull request the owner
  merges, **after** `release` — promoting the backup first would make it the known-good copy of
  something nobody has run in production. It is never a base for new work, and a `main` that has
  moved is the backup being taken rather than drift. *(Owner directive 2026-09-01; supersedes
  ADR 005's "retired at scaffold" consequence.)*
- `githooks/pre-push` refuses direct pushes to `develop`, `main`, `master` and (via
  `githooks/owner-only`) `release`. Enable it once per clone: `git config core.hooksPath githooks`.
  It runs `githooks/checks` before any other push.

## Owner runbook — the steps only the owner can do

1. **Create the Supabase project** (Free; region near Ohio). Paste every `supabase/migrations/*.sql`
   in the SQL editor — numeric order, except **0003 after 0004** (its functions call `is_admin()`,
   which 0004 creates). **0015 must be last**, which numeric order already gives you: it creates
   nothing and only takes privileges away from what the earlier files created, so a table pasted
   after it keeps the platform's default grant to `anon` and the sweep never saw it. Until it is
   pasted, `npm run check:live` exits 1 and names what `anon` can still reach — on the live
   project as of 2026-08-30 that is `club`, `answer_counts()` and `accept_answer()`. Then paste
   the **club row**, which no migration seeds and without which
   `/api/join` answers a bare 500 and nobody can sign in (measured 2026-08-23 on the live project,
   whose `club` table was empty):

   ```sql
   insert into public.club (name, brand_disc, brand_mark, invite_code, admin_email)
     values ('Hoover Sailing Club', '#395FAC', '#FCCF0B', 'CHANGEME', 'you@example.org');
   ```

   `admin_email` is yours: the person who signs in with that address becomes the admin
   (0009's trigger sets `person.is_admin` on their first sign-in, and on an existing person the
   moment the column is set), so `/admin` loads with no SQL run against `person`. The colours are
   the Hoover pair (`brand/`); the code is a placeholder you rotate from `/admin` once signed in.
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
   | Allow new users to sign up | **ON** (since #70, 2026-08-23 — it read OFF until then, and was never actually in force: the toggle did not persist, #12/#50). Tender is still invite-only, but the refusal moved out of the dashboard: a Google sign-up has to be allowed to create the auth user, so `/auth/callback` deletes any new auth user that arrives without a valid gate pass (`src/auth/person.ts`). Switching this OFF breaks *Continue with Google* for new members. Its cost is **stray auth users**, which since #85 the invite gate handles — see below |
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

   **Google provider** (#70). In Google Cloud, an OAuth client of type *Web application* with
   `https://<project-ref>.supabase.co/auth/v1/callback` as its authorised redirect URI; its client
   id and secret go under **Authentication → Providers → Google** in Supabase. A member whose
   account the email gate created and who later signs in with a Google account carrying the same
   verified address is linked to the existing user by Supabase (automatic identity linking) — #70's
   AC 6 is where that is measured. **A different address is not linked**, which is what *Allow
   manual linking* below is for. And a fifth server-only name beside the four above:
   **`GATE_PASS_SECRET`**, any long random string (`openssl rand -base64 32`), in `.env.local` and in
   Vercel's environment — it signs the ten-minute gate pass that carries a new member's name and
   attestation from the sign-up form through Google and back to `/auth/callback`. Without it the
   Google sign-up route throws and the callback treats every pass as invalid.

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
   three — and `GATE_PASS_SECRET` under the Google provider above is the fifth): since #23 the app sends the rung notifications itself, by Resend's REST API from
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

## Brand

`brand/` holds the mark set and `TenderMark.jsx` from the 2026-08-21 brand work. The four SVGs
there are the **Hoover-themed** pair (`#395FAC` / `#FCCF0B`); the default-green exports the
brand README's table names were never exported. Inline the component — never `<img src>` an SVG
that uses the page's colours.
