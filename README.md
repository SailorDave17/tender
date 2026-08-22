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
| Testing | Vitest for the engine, pglite for RLS, Playwright smoke later | [006](docs/adr/006-testing-strategy.md) |
| Notifications — the bet | Web push from an installed PWA + email to the current rung (Resend) | [007](docs/adr/007-notification-channel-the-bet.md) |

## Working on it

```
npm ci
npm run dev        # http://localhost:3000
npm test           # vitest: the engine (src/engine) and the RLS harness (test/)
npm run lint
npm run typecheck
npm run check:live # read-only probe of the live Supabase project; needs .env.local
```

Node 24 (`.nvmrc`). Copy `.env.example` to `.env.local` — names only are committed, never values.

**The engine** is `src/engine/ladder.ts`, a pure function: a post, a pool and a clock in; the open
rung and the candidates (each carrying their own rung) out. Its test is the scaffold's one real
test: six mutations on 2026-08-21 reddened exactly the predicted 3, 1, 2, 3, 1, 1 of 14
(`docs/adr/006-testing-strategy.md`).

**The RLS harness** (`test/pglite.ts`) applies `supabase/migrations/*.sql` to an in-memory
Postgres and runs SQL as `anon` or `authenticated`. It creates those roles itself and is therefore
blind to any grant the live project has that the migrations lack — `npm run check:live` is the
instrument for that, and it probes with `limit=0` so it can never write.

## Branches and deploys

- `develop` is the default and integration branch. Feature branches → PR → `develop`.
- `release` is Vercel's production branch. **Merging into `develop` deploys nothing**; promoting
  `develop` → `release` is the deploy, and it is the owner's — after any new migration has been
  pasted into the live project.
- `githooks/pre-push` refuses direct pushes to `develop`, `main`, `master` and (via
  `githooks/owner-only`) `release`. Enable it once per clone: `git config core.hooksPath githooks`.
  It runs `githooks/checks` before any other push.

## Owner runbook — the steps only the owner can do

1. **Create the Supabase project** (Free; region near Ohio). Paste every `supabase/migrations/*.sql` in order
   in the SQL editor. Put the URL and anon key in `.env.local`, and in Vercel's environment.
   Enable the **Cron** integration and confirm a job can be scheduled on this plan — ADR 004's
   kill condition; its fallback is named there.

   Then set three fields under **Authentication → URL Configuration / Sign In**. They are listed
   because a field nobody sets stays at the vendor's default permanently, and a default leaves no
   wrong value to notice — Supabase ships **Site URL** as `http://localhost:3000`, which points
   every confirmation email it ever sends at the recipient's own machine:

   | Field | Value |
   |---|---|
   | Site URL | `https://tender.madcowsailing.com` |
   | Redirect URLs | `https://tender.madcowsailing.com/**` and `http://localhost:3000/**` |
   | Allow new users to sign up | **OFF** — Tender is invite-only; people arrive through the invite code |

   Check it without the dashboard: `GET /auth/v1/settings` reports signups disabled, and a
   deliberately failing `GET /auth/v1/verify?token=x` redirects to `tender.madcowsailing.com`
   rather than to localhost.
2. **Custom SMTP**: Supabase's built-in mailer sends 2 emails an hour to team members only
   (measured 2026-08-21). Point Auth → SMTP at Resend, sending from `tender.madcowsailing.com`;
   add Resend's DNS records in the Cloudflare zone.
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
