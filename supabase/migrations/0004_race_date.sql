-- 0004 — race dates: the season's calendar, entered by hand with a start time (story #17).
--
-- Numbered per the filing plan (0003 is #16's invite-code rotation, which may land after this
-- file); a gap in the sequence is harmless to the harness, which sorts and applies whatever is
-- present, and to the owner's paste, since neither file depends on the other. **0002 must be
-- applied first**: is_admin() below is a `language sql` function, and Postgres validates a SQL
-- function's body at CREATE time, so pasting this before 0002 fails with 42P01 on public.person
-- (measured on the live project, 2026-08-22).
--
-- starts_at is a timestamptz and nothing else: the ladder clock (rungOpenedByClock) subtracts
-- from a datetime, so a race day without a start time has no meaning to the engine. The admin
-- screen resolves the club's local wall time (America/New_York) to an instant before it gets
-- here; the database stores and compares instants only. A date with no time is refused at the
-- form, never defaulted — the column is NOT NULL so nothing can slip one in from elsewhere.
--
-- published is the one switch between "the admin is still typing the season in" and "the board
-- shows it". A crew sees published rows only; the admin sees every row so the list can be
-- edited before it is shown. Writes are admin-only, decided by is_admin() below.

create table public.race_date (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null,
  title      text not null check (length(title) between 1 and 80),
  published  boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.race_date enable row level security;

-- ---------------------------------------------------------------------------------------------
-- is_admin(): is the signed-in person an admin? Security INVOKER on purpose — authenticated
-- already holds select on person (id, is_admin) under a read-everyone policy (0002), so the
-- function needs no more privilege than its caller has, and cannot become a privilege escalation
-- route if a later migration narrows person's read policy: it would simply start answering
-- false. No parameters, so nothing to shadow a column name
-- (cairn: postgres-sql-function-parameter-shadowing-2026-08-21).
-- ---------------------------------------------------------------------------------------------

create function public.is_admin() returns boolean
  language sql stable
  set search_path = ''
as $$
  select coalesce((select p.is_admin from public.person p where p.id = auth.uid()), false)
$$;

grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Privileges, by column (see 0002 for why the whole-table defaults are revoked first). id and
-- created_at are withheld from insert and update: the database assigns both, and a client that
-- could set id could pre-empt a row it does not own.
-- ---------------------------------------------------------------------------------------------

revoke all on public.race_date from anon, authenticated;

grant select (id, starts_at, title, published, created_at) on public.race_date to authenticated;
grant insert (starts_at, title, published) on public.race_date to authenticated;
grant update (starts_at, title, published) on public.race_date to authenticated;
grant delete on public.race_date to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Policies. The grants above say which columns a signed-in person MAY touch; these say which
-- rows. A non-admin insert fails loudly (42501, row-level security); a non-admin update or
-- delete matches zero rows, because the using clause hides every row from it.
-- ---------------------------------------------------------------------------------------------

create policy race_date_read on public.race_date
  for select to authenticated
  using (published or public.is_admin());

create policy race_date_admin_insert on public.race_date
  for insert to authenticated
  with check (public.is_admin());

create policy race_date_admin_update on public.race_date
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy race_date_admin_delete on public.race_date
  for delete to authenticated
  using (public.is_admin());
