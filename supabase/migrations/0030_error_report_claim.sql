-- 0030 — error_report_claim: the error reporter's window, made atomic across instances (story #198).
--
-- **Apply in numeric order, after 0029.** It reads no earlier table and calls no earlier function,
-- so nothing before it is a prerequisite beyond the schema existing; it creates one table and one
-- function, both reached only by the service role.
--
-- WHAT WENT WRONG. On 2026-09-22 at 00:56:09Z one service-role read of `club` was refused, and the
-- owner received TWO identical error reports. Supabase's edge log for that minute holds exactly
-- one refused read, and two dedupe reads 18 ms apart and two log writes 6 ms apart followed it —
-- so both reports came from ONE failed request, on one instance. `reportError()`
-- (src/notify/error.ts) checked its windows and only started them after two awaited store reads,
-- so two concurrent reports of the same signature both passed every check. The in-process half of
-- that is fixed in the reporter by taking the in-memory slot before the first await. This file is
-- the cross-instance half, by owner decision at pickup.
--
-- WHY A CLAIM, AND NOT THE LOG READ #43 ALREADY HAS. `notification_log`'s row for an attempt is
-- written AFTER the provider answers (~3 s measured for that send), so two instances failing
-- inside one send's latency both read "nothing in the last hour" and both send. A read cannot
-- close that gap; only a write the database arbitrates can. `insert … on conflict do update …
-- where` is that write: Postgres takes the row lock, so of two concurrent claims on one signature
-- exactly one inserts or updates, and the other sees the winner's row and updates nothing. The log
-- read stays in front of this as the cheap path for the ordinary repeat; this is the gate
-- immediately before the send.
--
-- WHY THE INSTANTS ARE ARGUMENTS. The reporter is pure over an injected `now`, and 0026's header
-- gives the reason a second clock here would be wrong: the window is decided at the instant the
-- caller decided everything else. `p_since` is that instant minus the hour
-- (ERROR_EMAIL_WINDOW_MS). A claim at or before it has lapsed and may be taken again, which is the
-- same boundary as the in-process window's `at - seen < window`.
--
-- WHY IT RETURNS THE HOLDER'S INSTANT. The loser records the winner's `claimed_at` in its own
-- in-process window, as #43 already does for a logged attempt, so its window ends when the real
-- one does and not an hour after its own occurrence. The second read is a separate statement, so
-- under READ COMMITTED it sees a winner that committed while the insert waited on its lock.
--
-- WHY THE TABLE NEVER NEEDS PRUNING. One row per SIGNATURE, keyed by it, so it holds as many rows
-- as there are distinct error names on distinct routes, and a new occurrence overwrites the row
-- rather than adding one. It is not a log; `notification_log` is the record of what was sent.
--
-- GRANTS. The table: RLS on with no policy, and `revoke all` from anon and authenticated. The
-- `authenticated` half is load-bearing (the platform's default privileges grant it everything on a
-- new table) and the `anon` half is ceremonial since 0015, which removed anon's default. The line
-- still names both, as every file does, and this header does not claim the anon refusal as its
-- own (#68). `select, insert, update` go to the service role by name, because the local image
-- grants it nothing on a new table (0010's header) and `on conflict do update … where … returning`
-- needs all three.
--
-- The function: `revoke all … from public, anon, authenticated`. `public` is load-bearing
-- (Postgres's built-in EXECUTE to PUBLIC, which 0015 cannot reach), `authenticated` is load-bearing
-- (the platform's default EXECUTE to it on every new function, #41), and `anon` is ceremonial for
-- the same reason as the table's. Execute goes to the service role by name. Security INVOKER, not
-- definer: its one caller is the service role, which already holds the table grants above, so a
-- definer would add a privilege boundary with nothing on the other side of it.

create table public.error_report_claim (
  signature  text primary key check (length(signature) between 1 and 400),
  claimed_at timestamptz not null
);

alter table public.error_report_claim enable row level security;

revoke all on public.error_report_claim from anon, authenticated;
grant select, insert, update on public.error_report_claim to service_role;

create function public.claim_error_report(
  p_signature text,
  p_at        timestamptz,
  p_since     timestamptz
) returns table (won boolean, held_since timestamptz)
  language plpgsql volatile
  set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  insert into public.error_report_claim as c (signature, claimed_at)
    values (p_signature, p_at)
    on conflict (signature) do update
      set claimed_at = excluded.claimed_at
      where c.claimed_at <= p_since
    returning c.claimed_at into v_at;
  if found then
    return query select true, v_at;
    return;
  end if;
  return query
    select false, c.claimed_at
      from public.error_report_claim c
     where c.signature = p_signature;
end;
$$;

revoke all on function public.claim_error_report(text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_error_report(text, timestamptz, timestamptz) to service_role;
