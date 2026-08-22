-- 0005 — the supply side of the board (story #18): a crew's competence, hull willingness and
-- phone on their profile, the club's fleet list, and which race days each person can sail.
--
-- Numbered per the filing plan (0003 is #16's invite-code rotation and may land after this
-- file; the sequence can carry a gap, harmlessly). **Paste order: 0002, 0004, then this** —
-- it alters person (0002) and availability references race_date (0004), so either missing
-- fails the paste with 42P01.
--
-- Three things, each on the table the charter puts it on:
--
--   person        rating, any_hull, hulls. any_hull is an explicit flag rather than "empty hulls
--                 means any": the engine (src/engine/ladder.ts) reads an empty array as any hull,
--                 and a schema where an empty array could also mean "none chosen yet" would
--                 invert that silently. The check constraint refuses the one state that would:
--                 any_hull false with no classes chosen. src/engine/toCrew.ts carries the flag
--                 into the engine's shape (hulls [] when any_hull) and is tested both ways.
--   boat_class    the fleet list, seeded here (owner decision G, 2026-08-22: every HSC fleet
--                 class except Laser). Additions are migrations, not an admin screen.
--   availability  person × race_date, the rows the ladder proposes from. A person writes only
--                 their own rows; every signed-in person reads them all, so the board can count
--                 who can sail each day and a skipper's post (#19) can list its candidates.
--
-- rating is nullable on purpose: a person exists from their first sign-in (0002, the invite
-- gate) before they have said how competent they are, and the board sends an unrated crew to
-- /profile before they can mark a day. The availability insert policy below makes that rule
-- the database's too — an availability row for someone the engine cannot rank is meaningless.
--
-- phone stays on person_contact (0002's PII table): this migration grants the person an update
-- on that one column, and nothing else there changes. A reader of another person's profile gets
-- no phone because person_contact's select policy is still self-only; the accept story (#21) is
-- what widens it.

-- ---------------------------------------------------------------------------------------------
-- person: the profile columns.
-- ---------------------------------------------------------------------------------------------

alter table public.person
  add column rating   smallint check (rating in (1, 2, 3)),
  add column any_hull boolean not null default true,
  add column hulls    text[] not null default '{}',
  add constraint person_hulls_chosen_or_any check (any_hull or cardinality(hulls) > 0);

grant select (rating, any_hull, hulls) on public.person to authenticated;
grant update (rating, any_hull, hulls) on public.person to authenticated;

-- person_update_self (0002) already limits an update to the person's own row; the column grant
-- above is what lets these three columns through it.

grant update (phone) on public.person_contact to authenticated;

create policy person_contact_update_self on public.person_contact
  for update to authenticated
  using (person_id = auth.uid())
  with check (person_id = auth.uid());

-- ---------------------------------------------------------------------------------------------
-- boat_class: the fleet list. Read by every signed-in person (the profile's hull picker, a
-- skipper's boat form in #19); written by nobody through a client.
-- ---------------------------------------------------------------------------------------------

create table public.boat_class (
  name text primary key check (length(name) between 1 and 40)
);

alter table public.boat_class enable row level security;

revoke all on public.boat_class from anon, authenticated;
grant select on public.boat_class to authenticated;

create policy boat_class_read_authenticated on public.boat_class
  for select to authenticated using (true);

insert into public.boat_class (name) values
  ('Flying Scot'),
  ('Highlander'),
  ('Interlake'),
  ('MC Scow'),
  ('Thistle'),
  ('Windmill');

-- ---------------------------------------------------------------------------------------------
-- availability: who can sail which day. A row is a yes; its absence is a no, so there is no
-- update — a person inserts to say yes and deletes to take it back.
-- ---------------------------------------------------------------------------------------------

create table public.availability (
  person_id    uuid not null references public.person (id) on delete cascade,
  race_date_id uuid not null references public.race_date (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (person_id, race_date_id)
);

alter table public.availability enable row level security;

revoke all on public.availability from anon, authenticated;
grant select (person_id, race_date_id, created_at) on public.availability to authenticated;
grant insert (person_id, race_date_id) on public.availability to authenticated;
grant delete on public.availability to authenticated;

create policy availability_read_authenticated on public.availability
  for select to authenticated using (true);

-- Own row only, and only once rated: the subquery runs as the caller, who can always read their
-- own person row (0002), so an unrated person's insert is refused here rather than landing as a
-- row the engine ignores. Refused loudly (42501), like any row-level insert refusal.
create policy availability_insert_self on public.availability
  for insert to authenticated
  with check (
    person_id = auth.uid()
    and exists (select 1 from public.person p where p.id = auth.uid() and p.rating is not null)
  );

create policy availability_delete_self on public.availability
  for delete to authenticated
  using (person_id = auth.uid());
