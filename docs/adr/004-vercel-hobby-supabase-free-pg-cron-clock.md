# ADR 004 — Vercel Hobby + Supabase Free, ladder clock as pg_cron

- Status: accepted 2026-08-21
- Phase: 6 (cliffs re-checked in phase 8)

## Context
Budget ceiling $0/month (*reported*). The engine must step a post down a rung at 48 h and 24 h before the race — a scheduler that fires hourly at worst. Load is spiky on the race calendar (recorded unknown, default); the off-season is silent for five months.

## Options considered (billing/docs pages fetched 2026-08-21, all *measured*)
- **Vercel Hobby + Supabase Free, clock in the database** — Vercel cron on Hobby is *once per day, ±59 min precision* (docs last updated 2026-07-15), useless for the clock, so the clock runs as pg_cron inside Postgres ("every second to once a year"). Cliffs: Hobby is non-commercial personal use only (a club pilot qualifies); Supabase Free pauses after 7 idle days; Supabase Cron's plan availability is **not stated** on either docs page read. The stack Taskr and burgee run, with the house's deepest notes.
- **Cloudflare Workers + Pages + D1, Cron Triggers** — free, never pauses, 5 cron triggers with no frequency floor, 100k requests/day, 10 ms CPU. madcowsailing already deploys to Cloudflare. No built-in auth or realtime: magic links and the match thread are hand-built; no house Cloudflare-auth notes.

  *2026-08-26 (#99): the magic link was removed from the app. This line is kept exactly as written — it is a counterfactual about a road not taken, describing what a Cloudflare build would have had to hand-roll in 2026-08, and nothing about the app changing can make a statement about the rejected option false.*
- **Vercel Hobby + Neon Free + an external cron pinger** — Neon auto-suspends after 5 min and auto-resumes; no inactivity pause stated. The clock becomes a third-party ping service with nobody's SLA; auth hand-built.

## Decision
Vercel Hobby + Supabase Free with the ladder clock as pg_cron. Won on house knowledge and built-in auth; the scheduler constraint is solved by moving it into the database rather than paying for Vercel Pro.

## Consequences
- Custom SMTP from day one: the built-in mailer is 2/hour to team members only (ADR 007).
- A weekly GitHub Actions schedule pings the project so it never idles (phase 8); GitHub disables schedules after 60 days of repo inactivity, so a spring check stays in the runbook.
- Previews are gated with Standard Protection (free on Hobby, *measured* on Taskr 2026-08-21) because a preview carries the production Supabase host.
- Production is the `release` branch (ADR 005).
- **The clock is what retries a pending send, and that ownership had to be stated rather than assumed** (#128, 2026-09-18). `dispatchPending()` (`src/notify/rung.ts`) leaves `suggestion.notified_at` NULL whenever a send was refused by the provider or skipped at Resend's daily cap, on the contract that "the next call retries that person alone". Three callers can be that next call: the post-create action, the availability toggle, and this clock. Until #128 the clock was **not** one of them — `tick-handler.ts` dispatched a post only when the pass had proposed somebody *new*, and a person skipped at the cap is written into `suggestion` by the pass that skipped them, so they are never new again. The retry therefore depended on a *different* crew marking the same date, and if nobody did, the email was never sent at all. The quarter-hour schedule made this worse rather than better: ninety-six passes a day, each finding nobody new and skipping the dispatch, and the pass due to resend after the cap clears at UTC midnight is one of them.

  The handler now dispatches on `TickedPost.pending` — a post has a suggestion row owed a send — which makes the clock the reliable retry path and leaves the other two callers unchanged. **The accepted cost** (owner decision 2026-09-18) is that an address the provider permanently refuses is now retried on every tick, each attempt counting against the 100/day cap. That trade was taken because the cap case is systematic and the bad-address case is pathological; if it ever bites, `notification_log` already distinguishes them — a cap skip is `rung_email_skipped_cap`, a refusal is `rung_email` with an `error` — so the condition can be narrowed without a schema change.

## Kill condition
pg_cron unavailable on the Free project when enabled at scaffold. **Fallback, named**: relaxation evaluated lazily on every board read plus Vercel's daily cron as a sweep — no scheduler at all — and if that proves too coarse in season one, reopen toward Cloudflare Workers. A second kill: a Hobby fair-use challenge, which routes to Cloudflare rather than to Pro.

### Kill condition NOT fired — measured 2026-08-22 (story #12)

`create extension if not exists pg_cron` succeeded on the live Free project (`iszdmtinhgnjwtnyetdn`, org "Mad Cow"), and `cron.schedule('tender_cron_probe', '* * * * *', …)` returned jobid 1. A scratch table `public.cron_probe` then collected **9 rows, every consecutive pair exactly 60 s apart** — first fire 15:05:00.219642+00 after scheduling at ~15:04:42, then 15:06:00, 15:07:00 … 15:13:00, each interval 60 s with no drift and no missed tick. Job and table were dropped afterwards (`cron.unschedule` → `jobs_left = 0`; `drop table` → `to_regclass('public.cron_probe')` = NULL).

So the clock decision stands: **the ladder clock is pg_cron**, and the named fallback stays unbuilt.

**One measurement trap, recorded because it nearly inverted this decision.** The probe rows were first read over PostgREST with the publishable key, which returned `HTTP 200 []` — read as *the job never fired*, which would have fired the kill condition and shipped the fallback architecture. It was wrong: this project enables row-level security on a plain `create table` (`pg_class.relrowsecurity` = true for `cron_probe`, which no migration asked for), so `[]` was **RLS filtering an anon role with no policy**, not an empty table. Counting from the SQL editor as `postgres` showed 8 rows at the same moment. An anon read cannot distinguish *no rows* from *no permission to see rows*; count from a role that bypasses RLS before concluding a scheduler is dead.
