# ADR 004 — Vercel Hobby + Supabase Free, ladder clock as pg_cron

- Status: accepted 2026-08-21
- Phase: 6 (cliffs re-checked in phase 8)

## Context
Budget ceiling $0/month (*reported*). The engine must step a post down a rung at 48 h and 24 h before the race — a scheduler that fires hourly at worst. Load is spiky on the race calendar (recorded unknown, default); the off-season is silent for five months.

## Options considered (billing/docs pages fetched 2026-08-21, all *measured*)
- **Vercel Hobby + Supabase Free, clock in the database** — Vercel cron on Hobby is *once per day, ±59 min precision* (docs last updated 2026-07-15), useless for the clock, so the clock runs as pg_cron inside Postgres ("every second to once a year"). Cliffs: Hobby is non-commercial personal use only (a club pilot qualifies); Supabase Free pauses after 7 idle days; Supabase Cron's plan availability is **not stated** on either docs page read. The stack Taskr and burgee run, with the house's deepest notes.
- **Cloudflare Workers + Pages + D1, Cron Triggers** — free, never pauses, 5 cron triggers with no frequency floor, 100k requests/day, 10 ms CPU. madcowsailing already deploys to Cloudflare. No built-in auth or realtime: magic links and the match thread are hand-built; no house Cloudflare-auth notes.
- **Vercel Hobby + Neon Free + an external cron pinger** — Neon auto-suspends after 5 min and auto-resumes; no inactivity pause stated. The clock becomes a third-party ping service with nobody's SLA; auth hand-built.

## Decision
Vercel Hobby + Supabase Free with the ladder clock as pg_cron. Won on house knowledge and built-in auth; the scheduler constraint is solved by moving it into the database rather than paying for Vercel Pro.

## Consequences
- Custom SMTP from day one: the built-in mailer is 2/hour to team members only (ADR 007).
- A weekly GitHub Actions schedule pings the project so it never idles (phase 8); GitHub disables schedules after 60 days of repo inactivity, so a spring check stays in the runbook.
- Previews are gated with Standard Protection (free on Hobby, *measured* on Taskr 2026-08-21) because a preview carries the production Supabase host.
- Production is the `release` branch (ADR 005).

## Kill condition
pg_cron unavailable on the Free project when enabled at scaffold. **Fallback, named**: relaxation evaluated lazily on every board read plus Vercel's daily cron as a sweep — no scheduler at all — and if that proves too coarse in season one, reopen toward Cloudflare Workers. A second kill: a Hobby fair-use challenge, which routes to Cloudflare rather than to Pro.
