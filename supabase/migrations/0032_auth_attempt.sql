-- 0032 — auth_attempt: a bound on guessing at the invite gates and the sign-in form (story #206).
--
-- **Apply in numeric order, after 0031.** It reads no earlier table and calls no earlier function,
-- so nothing before it is a prerequisite beyond the schema existing; it creates one table and two
-- functions, all reached only by the service role.
--
-- WHAT IT BOUNDS. security-audit 2026-09-22, finding SA-5 (A07:2025): nothing limited how often a
-- caller could try an invite code or a password. Since #220 the invite code is the whole of a
-- sign-up, and it is checked at two routes — `/api/join` and `/api/signup/google`, the second
-- checking it BEFORE the Google token is exchanged, so a junk credential is enough to guess with.
-- Both gates and `/api/signin` count against one budget per source address, so guesses cannot be
-- spread across them; `/api/signin` and `/api/join` also count per submitted email address, which
-- is what stops a guesser who rotates addresses. `/api/forgot` has a budget of its own per source
-- address, counting every request, because it has no failure to count and its cost is mail.
-- The limits and the window are arguments, not literals here: they live in
-- `src/auth/attempt-limit.ts` beside the code that reads them, as 0026 takes its kinds.
--
-- WHY A RESERVATION, NOT A COUNT AND THEN A RECORD. Reading "how many failures" and then, after
-- the attempt, writing one more is not a limit: a hundred parallel guesses all read the same count
-- under the limit and all proceed. So `begin_auth_attempt` takes a transaction-scoped advisory lock
-- per key, counts, and — only if under — INSERTS a row for this attempt in the same transaction,
-- before the attempt runs. The next caller on that key waits on the lock and sees the row. The
-- route then calls `settle_auth_attempt` to delete the row when the attempt turned out not to be a
-- failure, so what remains in the window is failures and attempts still in flight. A settle that
-- never arrives leaves the row counted, which is the direction to fail in. The two locks are
-- always taken source address first, email second, so no two callers can wait on each other in
-- a cycle. A refused call inserts nothing: the window slides on its own, and a clubhouse that hit
-- the limit is not kept locked by members retrying.
--
-- WHAT IT STORES, AND FOR HOW LONG. Neither the address nor the email is stored: the caller sends
-- SHA-256 hex digests. Rows older than the window are deleted by every `begin_auth_attempt`, so
-- the table holds at most one window of attempts and needs no cron. `/privacy` says so.
--
-- WHY A UUID KEY. An identity column would be this repo's first sequence, and README's note on
-- 0015 records that its sequence sweep has none to sweep; a sequence would need its own revoke from
-- the platform's default grants. `gen_random_uuid()` needs neither.
--
-- WHY THE INSTANTS ARE ARGUMENTS. 0026's reason: the caller decides at one instant, so the window
-- boundary is `p_since`, which the caller computes as `p_at` minus the window. A row at or before
-- `p_since` has lapsed, the same boundary as 0030's `claimed_at <= p_since`.
--
-- GRANTS. 0030's arrangement, for 0030's reasons. The table: RLS on with no policy; `revoke all`
-- from anon and authenticated (the `authenticated` half load-bearing, `anon` ceremonial since
-- 0015); select, insert and delete to the service role by name, since the local image grants it
-- nothing on a new table. The functions: `revoke all … from public, anon, authenticated` and
-- execute to the service role. Security INVOKER, not definer: the one caller is the service role,
-- which holds the table grants already, so a definer would add a privilege boundary with nothing
-- on the other side of it.

create table public.auth_attempt (
  id         uuid primary key default gen_random_uuid(),
  gate       text not null check (gate in ('join', 'signup-google', 'signin', 'forgot')),
  ip_hash    text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash text check (email_hash ~ '^[0-9a-f]{64}$'),
  at         timestamptz not null
);

create index auth_attempt_ip_at on public.auth_attempt (ip_hash, at);
create index auth_attempt_email_at on public.auth_attempt (email_hash, at) where email_hash is not null;
create index auth_attempt_at on public.auth_attempt (at);

alter table public.auth_attempt enable row level security;

revoke all on public.auth_attempt from anon, authenticated;
grant select, insert, delete on public.auth_attempt to service_role;

-- Returns this attempt's reservation id, or NULL when either key is already at its limit.
-- `p_gates` is the set of gates that share a budget with `p_gate`; `p_email_hash` NULL means
-- the attempt has no email key (the Google gate, the forgot screen).
create function public.begin_auth_attempt(
  p_gate        text,
  p_gates       text[],
  p_ip_hash     text,
  p_email_hash  text,
  p_at          timestamptz,
  p_since       timestamptz,
  p_ip_limit    integer,
  p_email_limit integer
) returns uuid
  language plpgsql volatile
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('auth_attempt:ip:' || p_ip_hash, 0));
  if p_email_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('auth_attempt:email:' || p_email_hash, 0));
  end if;

  delete from public.auth_attempt where at <= p_since;

  if (select count(*) from public.auth_attempt
       where ip_hash = p_ip_hash and gate = any (p_gates) and at > p_since) >= p_ip_limit then
    return null;
  end if;
  if p_email_hash is not null and (select count(*) from public.auth_attempt
       where email_hash = p_email_hash and gate = any (p_gates) and at > p_since) >= p_email_limit then
    return null;
  end if;

  insert into public.auth_attempt (gate, ip_hash, email_hash, at)
    values (p_gate, p_ip_hash, p_email_hash, p_at)
    returning id into v_id;
  return v_id;
end;
$$;

-- The attempt was not a failure: it no longer counts.
create function public.settle_auth_attempt(p_id uuid) returns void
  language sql volatile
  set search_path = ''
as $$
  delete from public.auth_attempt where id = p_id;
$$;

revoke all on function public.begin_auth_attempt(text, text[], text, text, timestamptz, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.begin_auth_attempt(text, text[], text, text, timestamptz, timestamptz, integer, integer) to service_role;

revoke all on function public.settle_auth_attempt(uuid) from public, anon, authenticated;
grant execute on function public.settle_auth_attempt(uuid) to service_role;
