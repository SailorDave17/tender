-- 0021 — the morning of the race: confirm, sailed, no-show (story #37).
--
-- Numbered by arrival, not by the filing plan: the plan said 0014, which #33 consumed for the
-- answer-notify grant (0014_answer_notify_grant.sql), and the directory now runs to 0020. The
-- story takes the next free number, which is the overlay's standing rule since #23 shipped as
-- 0010 against a filed 0009. The issue body carries the renumber note. **Apply order: after
-- 0020**, in numeric order; 0008 (match) and 0004 (race_date) must already be applied, since the
-- definer below reads both and plpgsql resolves them at call time, not at CREATE.
--
-- Apply it BEFORE promoting the `develop` that carries #37. From that deployment on, the match
-- panel's Confirm / Sailed / Did not show buttons call set_match_status() (PGRST202 until this
-- lands — the tap is refused, nothing breaks), and the ladder tick's morning-of pass reads
-- `reminded_at` (an error the tick logs and swallows, so the ladder half still runs). Neither
-- failure is loud; that is why this file asks to go first.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT ADDS
-- ---------------------------------------------------------------------------------------------
--
--   match.reminded_at   when the morning-of reminder was ATTEMPTED for this match (push and
--                       email both tried, whatever the provider answered). Null means not yet.
--                       Set once, by the tick's morning-of pass as the service role, and never
--                       cleared: a reminder retried every fifteen minutes at a refused address on
--                       race day would spend the email cap on the one day it matters most, and
--                       the cap clears at UTC midnight — 8 pm in Ohio, after the race (owner
--                       decision at pickup, 2026-09-18). notification_log carries the outcome.
--
--   match_status_transition()   the state machine, as one BEFORE UPDATE trigger:
--
--                                   accepted  → confirmed | sailed | no_show
--                                   confirmed → sailed | no_show
--                                   sailed, no_show: final
--
--                       `accepted → sailed` is allowed (owner decision 2026-09-18): the skipper's
--                       record of what happened is the fact the season's metric counts, and a
--                       crew who forgot to tap Confirm but turned up did sail. The charter's
--                       "accepted → confirmed → sailed | no-show" is the expected path, not the
--                       only legal one. A same-value update is a no-op, so a double tap on any
--                       button is idempotent rather than an error.
--
--   on_race_day(starts_at, moment)   whether `moment` falls on the race's calendar day in the
--                       club's zone. A separate STABLE function rather than an expression inside
--                       the definer, so the boundary — 23:59 the night before is refused, 00:00
--                       on the day is allowed, on both sides of a DST change — can be proven at
--                       pinned instants without waiting for midnight in Ohio. The zone literal
--                       here is the same one `CLUB_TZ` names in src/dates/race-date.ts, and
--                       test/match-status.test.ts holds the two implementations to the same
--                       answers on the same instants, DST days included.
--
--   set_match_status(match_id, status)   the one client route to a status change. Security
--                       DEFINER because `authenticated` holds no update on `match` by design
--                       (0008): the only way to move a status is through the checks here, which
--                       take the caller from auth.uid() and never from an argument.
--
--                         'confirmed'  the CREW, and only on the race day (local). Before 00:00
--                                      on the race day, refused; the day after, refused; the
--                                      skipper, refused. After the start on the race day is
--                                      still allowed — the crew who confirms from the dock at
--                                      12:58 is confirming.
--                         'sailed'     the SKIPPER, and only after starts_at.
--                         'no_show'    the SKIPPER, and only after starts_at.
--
--                       Who is refused with 42501, so the client sees a permission refusal;
--                       when is refused with the default raise code (P0001) and a sentence.
--                       The transition itself is not re-checked here — the trigger is the
--                       single copy of that rule, and it fires inside this function's UPDATE.
--
-- ---------------------------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------------------------
--
-- `authenticated`: execute on set_match_status, and nothing on the table beyond 0008's column
-- select. `status` was already in that select list, so every signed-in person reads it on a
-- match they can see — the board shows "confirmed" and "did not show" to everyone, since a
-- crewed boat's state is news the way the match itself was (0008's header). `reminded_at` is
-- NOT granted to any client role: it is the server's record of its own send, like
-- tick_run.last_at.
--
-- `service_role`: update on the ONE column the morning-of pass writes. Explicit, because the
-- current Supabase Postgres image grants service_role no DML on a table it did not create while
-- the hosted project has been measured granting ALL (cairn: supabase-rls-column-grants), and
-- the pglite harness measures the files alone. Select is 0018's already, and a table-level
-- select covers a column added later. No update on `status` for the service role: the definer is
-- the only writer of that column, so a bug in the tick cannot mark anyone sailed.
--
-- `anon`: nothing, by name — the hosted project grants anon execute on every new function at
-- creation, and the local image does not (cairn: postgrest-probing-a-live-project §4).
--
-- Every parameter is qualified as set_match_status.param: `match` carries a column named
-- `status`, and a bare name inside a function body resolves to the column first (cairn:
-- postgres-sql-function-parameter-shadowing-2026-08-21). plpgsql's default
-- #variable_conflict = error would raise on the ambiguity rather than silently degenerate the
-- way a `language sql` body does; the qualification is kept anyway, so the body does not depend
-- on that default and reads as what it means.

alter table public.match add column reminded_at timestamptz;

-- The morning-of pass's one write. Column-scoped on purpose: see GRANTS above.
grant update (reminded_at) on public.match to service_role;

-- ---------------------------------------------------------------------------------------------
-- The state machine.
-- ---------------------------------------------------------------------------------------------

create function public.match_status_transition() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  -- A same-value write is a no-op, not an error: a second tap on Confirm confirms a confirmed
  -- match and lands here with old = new.
  if old.status = new.status then
    return new;
  end if;
  if old.status in ('sailed', 'no_show') then
    raise exception 'match is % and that is final', old.status
      using errcode = 'check_violation';
  end if;
  if old.status = 'accepted' and new.status in ('confirmed', 'sailed', 'no_show') then
    return new;
  end if;
  if old.status = 'confirmed' and new.status in ('sailed', 'no_show') then
    return new;
  end if;
  raise exception 'match status may not go from % to %', old.status, new.status
    using errcode = 'check_violation';
end
$$;

revoke all on function public.match_status_transition() from public, anon, authenticated;

create trigger match_status_transition
  before update of status on public.match
  for each row execute function public.match_status_transition();

-- ---------------------------------------------------------------------------------------------
-- The race-day rule, as a function the tests can pin.
-- ---------------------------------------------------------------------------------------------

create function public.on_race_day(starts_at timestamptz, moment timestamptz) returns boolean
  language sql stable
  set search_path = ''
as $$
  select (on_race_day.moment at time zone 'America/New_York')::date
       = (on_race_day.starts_at at time zone 'America/New_York')::date
$$;

-- Nothing a client needs to call; the definer below calls it as its owner.
revoke all on function public.on_race_day(timestamptz, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The one client route to a status change.
-- ---------------------------------------------------------------------------------------------

create function public.set_match_status(match_id uuid, status text) returns text
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_match  public.match%rowtype;
  v_starts timestamptz;
begin
  if v_caller is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if set_match_status.status not in ('confirmed', 'sailed', 'no_show') then
    raise exception 'no such status: %', set_match_status.status using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_match from public.match m where m.id = set_match_status.match_id;
  if not found then
    raise exception 'not your match' using errcode = '42501';
  end if;
  select r.starts_at into v_starts
    from public.post p join public.race_date r on r.id = p.race_date_id
   where p.id = v_match.post_id;

  if set_match_status.status = 'confirmed' then
    if v_caller <> v_match.crew_id then
      raise exception 'only the crew confirms' using errcode = '42501';
    end if;
    if not public.on_race_day(v_starts, now()) then
      raise exception 'confirm on the race day';
    end if;
  else
    if v_caller <> v_match.skipper_id then
      raise exception 'only the skipper records sailed or no-show' using errcode = '42501';
    end if;
    if now() <= v_starts then
      raise exception 'sailed and no-show are recorded after the start';
    end if;
  end if;

  -- The trigger decides whether the transition is legal, and raises if not.
  update public.match set status = set_match_status.status where id = set_match_status.match_id;
  return set_match_status.status;
end
$$;

revoke all on function public.set_match_status(uuid, text) from public, anon;
grant execute on function public.set_match_status(uuid, text) to authenticated;
