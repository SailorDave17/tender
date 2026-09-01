-- 0017 — the ladder clock: pg_cron calls /api/ladder/tick every 15 minutes (story #26).
--
-- **Paste after 0016.** It creates nothing and reads no table this schema owns, so like 0015 and
-- 0016 it belongs at the end of the set and is safe to re-paste: `cron.schedule` is an UPSERT on
-- the job NAME, so a second paste replaces the schedule rather than adding a second job.
--
-- NUMBERING. The filing plan gave this story `0010`, which #23 consumed on 2026-08-23, and 0011
-- to 0016 have landed since. 0017 is the next free number on disk. Same rule as #23 → 0010 and
-- #25 → 0012 (owner decision 2026-08-23): the plan numbers at groom time, an in-session story
-- takes whatever is next, so the DIRECTORY is the authority and an AC's number is a prediction.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT IS FOR
-- ---------------------------------------------------------------------------------------------
--
-- The engine steps a post down a rung at 48 h and 24 h before the race (#25). Nothing makes that
-- happen: `/api/ladder/tick` widens every open post the clock has reached and emails the crew it
-- newly reaches, and until this file there was no caller. A board nobody opens on a Thursday
-- evening is exactly when the step-down matters most.
--
-- ADR 004 chose the database as the clock because Vercel's Hobby cron fires **once a day, ±59
-- min** — useless for a 48 h / 24 h boundary — while pg_cron will fire every 15 minutes. That
-- decision's kill condition was measured NOT to have fired (story #12: `cron.schedule` returned
-- jobid 1 and a probe table collected nine rows exactly 60 s apart). Vercel's daily cron ships
-- alongside as a second, coarser clock (`vercel.json`), so the two failure modes are independent:
-- a wedged pg_cron still gets a sweep every day, and a Vercel outage still leaves the 15-minute
-- clock running.
--
-- Postgres is ONLY a clock here. It makes an HTTP request and forms no opinion: every decision
-- about which posts move and who is emailed is `handleTick()` in the app, unit-tested with the
-- repo, the dispatch and the time injected. Nothing about the ladder is expressed in SQL.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE WHOLE FILE IS ONE GUARDED `do` BLOCK
-- ---------------------------------------------------------------------------------------------
--
-- `test/pglite.ts` applies every file in this directory to an in-memory Postgres that has no
-- pg_cron, no pg_net and no Vault — so an unguarded `cron.schedule` would fail at APPLY time and
-- take the whole RLS suite down with it. plpgsql prepares a statement when it first RUNS it, not
-- when the block is compiled, so nothing inside the guard is ever resolved on a server without
-- the extension: no `cron` schema is looked up, no `net.http_post` is planned, and the file is a
-- clean no-op. `test/ladder-tick-schedule.test.ts` holds both halves — that it applies silently
-- on pglite, and that with the guard taken away it does not.
--
-- ---------------------------------------------------------------------------------------------
-- WHY IT REFUSES WHEN pg_cron IS PRESENT AND pg_net IS NOT
-- ---------------------------------------------------------------------------------------------
--
-- This is the half that is not obvious, and it comes from a measurement rather than from caution.
--
-- *Measured 2026-09-01 against the live project*, reading `pg_available_extensions` and
-- `pg_extension` with a read-only management connection: **pg_cron is installed** (1.6.4, left
-- behind by #12's probe) and **pg_net is not** (available at 0.20.4, never created). Vault is
-- installed; `cron.job` and `vault.secrets` are both empty.
--
-- So a guard on pg_cron alone — which is what this story was filed asking for — PASSES on the
-- live project today, and the job it schedules calls into a `net` schema that does not exist. It
-- would then fail every fifteen minutes, ninety-six times a day, while
--
--     select jobname from cron.job;
--
-- — this story's own confirmation step — lists `ladder-tick` and reads entirely correct. That is
-- the failure `0012`'s header names in as many words: a tick that never runs looks exactly like a
-- tick that ran and found nothing to do, because both send no email and change no row.
--
-- Refusing at PASTE time is the cheapest place to catch it. The exception below names the
-- extension and the runbook step, so the person holding the SQL editor is told what to do rather
-- than left with a job that lies. Enabling pg_net is a dashboard action (Database → Extensions),
-- which is why this file asks for it rather than running `create extension` itself: applying a
-- migration and granting the project a new capability are different decisions, and only the first
-- one is what a paste is understood to be.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE URL AND THE SECRET ARE READ FROM VAULT AT RUN TIME
-- ---------------------------------------------------------------------------------------------
--
-- Neither is in this file, and neither can be: this repository is public. `vault.decrypted_secrets`
-- is read INSIDE the scheduled command, so what is committed here is two secret NAMES and the
-- shape of a request. Rotating the secret is then an update to a Vault row and no migration at
-- all. `test/ladder-tick-schedule.test.ts` greps `supabase/` for a bearer token and for a project
-- URL, so the criterion stays enforced rather than being a check somebody ran once.
--
-- The command refuses loudly when either secret is missing, and that is deliberate rather than
-- defensive. The natural spelling —
--
--     headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret ...))
--
-- — concatenates NULL to a string and produces NULL, so with the secret unset the request would
-- go out with no credential, the route would answer 401, and `cron.job_run_details` would record
-- the run as SUCCEEDED, because posting the request is all pg_net was asked to do. A raise puts
-- the reason in that table instead.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS FILE CANNOT PROVE, AND WHO PROVES IT
-- ---------------------------------------------------------------------------------------------
--
-- Nothing here is observable to `npm run check:live` (it reads tables and functions over
-- PostgREST) or to `npm run verify:migrations` (it reads `pg_catalog` for state the FILES
-- describe, and a `do` block describes a state only conditionally — see the note that command
-- prints for this file). The instrument is the live project itself, and it belongs to #27: the
-- job listed in `cron.job`, and a SUCCEEDED row in `cron.job_run_details` inside the last fifteen
-- minutes. Read both. The first alone is the reassuring half.

do $$
begin
  -- No pg_cron: this is the pglite harness, or any Postgres that is not the live project. Do
  -- nothing at all, and say nothing — a notice here would be noise on all sixteen boots of every
  -- test run.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  -- pg_cron IS present, so this is a real project and the rest of the clock is owed. Refuse
  -- rather than schedule a job that cannot work; see the header for the measurement.
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception
      'ladder-tick: pg_cron is installed but pg_net is not, so net.http_post cannot be called. '
      'Enable pg_net first (dashboard: Database -> Extensions), then paste this file again. '
      'Scheduling without it would list a job in cron.job that fails every 15 minutes.';
  end if;

  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception
      'ladder-tick: pg_cron is installed but supabase_vault is not, so the request URL and the '
      'bearer secret cannot be read. Enable it, create the two secrets named in README.md step 1, '
      'then paste this file again.';
  end if;

  -- Upsert by job NAME, so re-pasting this file replaces the schedule instead of adding a second
  -- job that would tick the ladder twice. Every 15 minutes: the engine's boundaries are 48 h and
  -- 24 h before a race, so a quarter-hour is two orders of magnitude finer than the thing being
  -- measured and costs 96 requests a day against a route that answers in milliseconds when there
  -- is nothing to do.
  perform cron.schedule('ladder-tick', '*/15 * * * *', $cmd$
do $tick$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'ladder_tick_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ladder_tick_secret';

  -- Refuse rather than post an unauthenticated request. Without this the route answers 401 and
  -- pg_cron records the run as succeeded, because the POST itself worked.
  if v_url is null or v_secret is null then
    raise exception 'ladder-tick: vault secret % is not set (README.md, owner runbook step 1)',
      case when v_url is null then 'ladder_tick_url' else 'ladder_tick_secret' end;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_secret
    )
  );
end
$tick$;
  $cmd$);
end
$$;
