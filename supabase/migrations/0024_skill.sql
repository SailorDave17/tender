-- 0024 — a crew ticks every skill they have, and their rung is derived from the ticked set
-- (story #68). The skills themselves become rows the club can add to by migration; `person.rating`
-- stays and is DERIVED, so the engine, the board banner and both skipper-side forms are untouched.
--
-- Numbered by arrival, not by the filing plan: the body filed 0012, which #25 consumed
-- (0012_tick_run.sql), and the directory now runs to 0023. The story takes the next free number —
-- the overlay's standing rule since #23 shipped as 0010 against a filed 0009. **Apply order: after
-- 0023**, in numeric order.
--
-- 0011 IS A HARD PREREQUISITE, not merely an earlier number, and the failure would be silent.
-- 0011 (#69) renumbered helms from 3 to 4 and gave 3 to the spinnaker. The backfill below reads
-- `rating` on THAT scale: applied before 0011, every helm at 3 would be written down as a
-- spinnaker hand and the person would go on being suggested for posts they cannot crew — no error,
-- no symptom (cairn: a-constraint-outlives-the-meaning-of-its-column). The seed's `level` values
-- are the same scale, so both halves of this file assume 0011 has run.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT ADDS
-- ---------------------------------------------------------------------------------------------
--
--   skill          the skill list, seeded here and read at request time — the shape 0005 set for
--                  `boat_class`: options the club will add to are rows, not a longer check
--                  constraint, so the next skill (foredeck, tactics) is a migration with no code
--                  change. Read by every signed-in person, written by nobody through a client.
--
--   skill.level    what keeps the ladder ordinal. The engine compares `rating` with `<`
--                  (src/engine/ladder.ts), and a ticked SET has no order; `level` is the mapping
--                  from a skill to the scale, and it is DATA, so the owner re-seeds it rather
--                  than a release changing it.
--
--   person.skills  the codes ticked. text[] with no foreign key, exactly as `person.hulls`
--                  (0005) holds class names with none — Postgres has no array FK, and the app
--                  refuses a code that is not in the list (src/profile/profile.ts), which is the
--                  one check the database does not make. Stated rather than discovered.
--
-- `rating` is NOT dropped and NOT made derived at read time. Four consumers read it (the engine,
-- toCrew, the availability rule, three display sites) and two skipper-side forms offer it as a
-- post's minimum; deriving it at SAVE keeps every one of them correct through this change, and
-- makes the backfill below a one-statement equivalence rather than a migration of behaviour.

-- ---------------------------------------------------------------------------------------------
-- skill: the list. Modelled on boat_class (0005) — same grants, same policy, same seeding.
-- ---------------------------------------------------------------------------------------------

create table public.skill (
  code  text primary key check (length(code) between 1 and 40),
  label text not null check (length(label) between 1 and 60),
  -- The competence scale as 0011 left it. Not a foreign key to anything: the scale is a check
  -- constraint on person.rating, boat.default_minimum and post.minimum, and this is a fourth
  -- site holding the same four values.
  level smallint not null check (level in (1, 2, 3, 4)),
  -- Display order on /profile. Separate from `level` on purpose: two skills may share a level
  -- once the club adds one, and the order the form shows them in is then still the owner's.
  sort  smallint not null
);

alter table public.skill enable row level security;

-- The `authenticated` half of this revoke is load-bearing and the `anon` half is not, which is
-- worth stating because both halves look identical. *Measured* by mutation: deleting this line
-- reddens 2 tests, both about `authenticated` — the platform's default privileges (reproduced in
-- test/pglite.ts) grant it everything on a new table, so without the revoke a member could insert
-- skills. `anon` is already covered by 0015's standing `alter default privileges … revoke all on
-- tables from anon`, so its refusal survives this line's deletion. Kept anyway: every migration
-- from 0002 on revokes its own table from both, and defence that costs one word stays.
revoke all on public.skill from anon, authenticated;
grant select on public.skill to authenticated;

create policy skill_read_authenticated on public.skill
  for select to authenticated using (true);

insert into public.skill (code, label, level, sort) values
  ('never-raced', 'Never raced',          1, 1),
  ('hike-trim',   'Can hike and trim',    2, 2),
  ('spinnaker',   'Can fly a spinnaker',  3, 3),
  ('helm',        'Can helm',             4, 4);

-- ---------------------------------------------------------------------------------------------
-- person.skills: the codes this person ticked.
-- ---------------------------------------------------------------------------------------------

-- `not null default '{}'` rather than nullable: an empty set and "not filled in yet" are the same
-- state here, and `rating is null` already answers that question for the board's banner. Every
-- existing row gets '{}' and is then backfilled below.
alter table public.person add column skills text[] not null default '{}';

-- Beside rating/any_hull/hulls (0005), through the same column grants. person_update_self (0002)
-- already limits an update to the caller's own row; the column grant is what lets this one
-- through it, and nothing here widens which ROW may be written.
grant select (skills) on public.person to authenticated;
grant update (skills) on public.person to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The backfill. One statement, and it is the equivalence that makes this migration safe to apply
-- to a project people are already using: every person reads the same `rating` afterwards as
-- before — this file writes `skills` and never touches `rating`.
--
-- A person with no rating keeps '{}' from the default above: they have not said anything yet, and
-- inventing `{never-raced}` for them would tick a box on their behalf and turn the board's
-- "set your competence first" banner off for someone who never set it.
-- ---------------------------------------------------------------------------------------------

update public.person
   set skills = case rating
                  when 1 then '{never-raced}'::text[]
                  when 2 then '{hike-trim}'::text[]
                  when 3 then '{spinnaker}'::text[]
                  when 4 then '{helm}'::text[]
                end
 where rating is not null;
