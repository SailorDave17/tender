-- 0002 — people. Two tables, split on purpose:
--
--   person          the public profile: who is in the club's pool, readable by every signed-in
--                   person so a skipper's post can list its candidates by name.
--   person_contact  the PII: email and phone, readable only by its owner today. The charter's
--                   "contact details are revealed only after a skipper accepts a match" is not
--                   expressible as a row policy on person — a policy decides which ROWS, never
--                   which COLUMNS — so contact lives in its own table and the accept story (#21)
--                   widens exactly one select policy here instead of touching person at all.
--
-- Adults-only is structural: adult_attested_at is NOT NULL, so a person row cannot exist without
-- the attestation having happened. No column records or lets anyone infer how old a person is —
-- story #14's AC 1 greps the migrations for the usual spellings and must find nothing, which is
-- why this comment does not spell them either.
--
-- No is_skipper flag: a skipper is whoever owns a boat row (0006).
--
-- Inserts are not granted to any client role. A person row is created by the invite gate, a
-- server route running as service_role (epic #7 decision E, story #15), so the invite code never
-- reaches a browser. service_role bypasses RLS and needs no policy. *Allow new users to sign up*
-- has been ON since #70 (2026-08-23) so that Google sign-up can mint the auth user; an auth user
-- arriving at /auth/callback without a gate pass is deleted there, so this route and the callback
-- are still the only person writers. (This comment said "with signups OFF" until #70.)

create table public.person (
  id                uuid primary key references auth.users (id) on delete cascade,
  display_name      text not null check (length(display_name) between 1 and 80),
  is_admin          boolean not null default false,
  adult_attested_at timestamptz not null,
  created_at        timestamptz not null default now()
);

create table public.person_contact (
  person_id uuid primary key references public.person (id) on delete cascade,
  email     text not null check (position('@' in email) > 1),
  phone     text
);

alter table public.person enable row level security;
alter table public.person_contact enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Privileges. Supabase grants anon, authenticated and service_role ALL on every new public table
-- through schema default privileges (measured on this project, tender #48), so a table that
-- grants nothing is still world-readable to any key. Revoke first, then grant by column.
--
-- Column grants are the only mechanism that restricts COLUMNS; RLS restricts rows. A column
-- withheld from the select grant makes `select('*')` fail loudly at the client, which is wanted:
-- adult_attested_at is withheld from person (no client reads it — it is structural, not data),
-- and invite_code from club (below). A withheld column is also unusable in WHERE and ORDER BY.
-- (cairn: supabase-rls-column-grants-2026-08-06)
--
-- The pglite harness grants nothing Supabase would, so the revokes below are no-ops there and
-- real on the live project. The schema-wide default itself is #48's, not this migration's.
-- ---------------------------------------------------------------------------------------------

revoke all on public.person from anon, authenticated;
revoke all on public.person_contact from anon, authenticated;

grant select (id, display_name, is_admin, created_at) on public.person to authenticated;
grant update (display_name) on public.person to authenticated;
grant select (person_id, email, phone) on public.person_contact to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Policies. Every signed-in person may see who is in the pool; only the person may change their
-- own name (the column grant above stops them changing anything else, whatever the policy says);
-- only the person may read their own contact row until #21 widens it to a matched skipper.
-- ---------------------------------------------------------------------------------------------

create policy person_read_authenticated on public.person
  for select to authenticated using (true);

create policy person_update_self on public.person
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy person_contact_read_self on public.person_contact
  for select to authenticated using (person_id = auth.uid());

-- ---------------------------------------------------------------------------------------------
-- club: narrow the whole-row select grant from 0001. Until now every signed-in person could read
-- invite_code, so rotating it (#16) would have protected nothing. The client reads the club's
-- name and theme; the code is checked by the invite gate running as service_role.
--
-- anon's default grants on club are deliberately not touched here — that is #48, which owns the
-- schema-wide revoke and the harness change that would make it testable.
-- ---------------------------------------------------------------------------------------------

revoke select on public.club from authenticated;
grant select (id, name, brand_disc, brand_mark, created_at) on public.club to authenticated;
