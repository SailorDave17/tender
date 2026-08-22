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

### Kill condition NOT fired — measured 2026-08-22 (story #12)

`create extension if not exists pg_cron` succeeded on the live Free project (`iszdmtinhgnjwtnyetdn`, org "Mad Cow"), and `cron.schedule('tender_cron_probe', '* * * * *', …)` returned jobid 1. A scratch table `public.cron_probe` then collected **9 rows, every consecutive pair exactly 60 s apart** — first fire 15:05:00.219642+00 after scheduling at ~15:04:42, then 15:06:00, 15:07:00 … 15:13:00, each interval 60 s with no drift and no missed tick. Job and table were dropped afterwards (`cron.unschedule` → `jobs_left = 0`; `drop table` → `to_regclass('public.cron_probe')` = NULL).

So the clock decision stands: **the ladder clock is pg_cron**, and the named fallback stays unbuilt.

**One measurement trap, recorded because it nearly inverted this decision.** The probe rows were first read over PostgREST with the publishable key, which returned `HTTP 200 []` — read as *the job never fired*, which would have fired the kill condition and shipped the fallback architecture. It was wrong: this project enables row-level security on a plain `create table` (`pg_class.relrowsecurity` = true for `cron_probe`, which no migration asked for), so `[]` was **RLS filtering an anon role with no policy**, not an empty table. Counting from the SQL editor as `postgres` showed 8 rows at the same moment. An anon read cannot distinguish *no rows* from *no permission to see rows*; count from a role that bypasses RLS before concluding a scheduler is dead.
