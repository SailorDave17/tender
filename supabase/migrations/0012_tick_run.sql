-- 0012 — tick_run: when the ladder clock last ran (story #25).
--
-- **Paste after 0011**, in numeric order. It reads is_admin() (0004), which every earlier paste
-- has already created.
--
-- NUMBERING. The filing plan gave this story no migration; 0012 is simply the next free number
-- on disk. That CONSUMES the 0012 that #68's AC 1 names (`0012_skill.sql`), so #68 becomes 0013
-- and #26 — whose AC 1 still says "migration 0010", consumed by #23 back in August — takes
-- whatever is free when it lands. Same collision and same rule as #23 → 0010 (owner decision
-- 2026-08-23): the plan numbers at groom time and an in-session story takes whatever is next,
-- so the directory is the authority and an AC's number is a prediction. Both issues carry a
-- renumber comment.
--
-- WHAT IT IS FOR. The ladder now steps down on the clock (#25): pg_cron and Vercel's daily sweep
-- (#26) call /api/ladder/tick, which widens every open post the clock has reached and emails the
-- crew it newly reaches. That whole mechanism is invisible from inside the app — a tick that
-- never runs looks exactly like a tick that ran and found nothing to do, because both send no
-- email and change no row. This table is the one artefact that separates them, and /admin reads
-- it as "last tick N min ago".
--
-- ONE ROW, BY CONSTRUCTION. `id smallint primary key default 1 check (id = 1)` makes the upsert
-- `insert … values (default, now()) on conflict (id) do update` unambiguous: there is exactly
-- one row to conflict with and no way to write a second. A bare table with no key would let a
-- bug append a row per tick and leave "last tick" a max() over a table nobody prunes.
--
-- WHO READS IT. Admins only, and via RLS rather than by withholding a column: nothing here is a
-- secret, so the column grants of 0002/0004 would be theatre, while the row filter matches who
-- the page is for. One consequence worth stating rather than discovering: a non-admin reads zero
-- rows, which is indistinguishable from "the tick has never run" (the ADR 004 measurement trap
-- in miniature). Nobody but an admin can render /admin, so no caller can be misled today — but a
-- second reader added later must ask which of the two it is seeing.

create table public.tick_run (
  id      smallint primary key default 1 check (id = 1),
  last_at timestamptz not null default now()
);

alter table public.tick_run enable row level security;

revoke all on public.tick_run from anon, authenticated;

-- The admin's read. No insert, update or delete grant to any client role: the row is the
-- server's record of its own clock, and a client that could write it could hide a dead tick.
grant select on public.tick_run to authenticated;

create policy tick_run_read_admin on public.tick_run
  for select to authenticated
  using (public.is_admin());

-- The tick's own upsert. Explicit, because the current Supabase Postgres image grants
-- service_role nothing on a new table (Dxtm only) while the hosted project grants ALL by
-- default — two surfaces that disagree about a value nobody set, so the file that creates the
-- table says what the server needs (cairn: supabase-rls-column-grants-2026-08-06).
grant select, insert, update on public.tick_run to service_role;
