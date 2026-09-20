-- 0027 — a person leaves: their data goes, their past matches stay as nameless rows (story #42).
--
-- Numbered by arrival, not by the filing plan: the plan said 0015, which #48 consumed
-- (0015_anon_revoke.sql), and the directory runs to 0026. The story takes the next free number,
-- which is the overlay's standing rule since #23 shipped as 0010 against a filed 0009. The issue
-- body carries the renumber note. **Apply after 0026**, in numeric order; 0006 (boat), 0008
-- (match) and 0021 (set_match_status) must already be applied, since this file alters the first
-- two and replaces the third.
--
-- Apply it BEFORE promoting the `develop` that carries #42. From that deployment on, /profile's
-- "Delete my account" calls delete_person() — PGRST202 until this lands, which the action reports
-- as a refusal and stops at, so the auth user is NOT deleted on a schema that cannot take the
-- person rows first (the order is the story's AC 2). Nothing breaks; the button does nothing.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THE CHARTER ASKS, AND WHAT A DELETE OF public.person ALREADY DID
-- ---------------------------------------------------------------------------------------------
--
-- Charter §Data: "deletion on request removes profile, availability and messages; past matches
-- remain as anonymised rows so the season's metric stays countable."
--
-- Every foreign key onto person, read from the files rather than from the issue — an acceptance
-- criterion that enumerates a cascade is a snapshot of the schema on its filing date (cairn:
-- a-symmetric-check-on-a-set-null-pair-refuses-the-delete). test/delete-person.test.ts holds
-- this table equal to pg_constraint, so a person-keyed table added later reddens the suite until
-- its rule is stated here.
--
--   person_contact.person_id      cascade    0002   the PII. ALSO deleted explicitly below.
--   availability.person_id        cascade    0005
--   boat.owner_id                 cascade    0006   CHANGED here → set null
--   answer.person_id              cascade    0007
--   match.skipper_id, crew_id     cascade    0008   CHANGED here → set null, flagged
--   suggestion.person_id          cascade    0010
--   notification_log.person_id    set null   0010   this story's rule, applied there from the start;
--                                                   to_email is BLANKED by delete_person below
--   push_subscription.person_id   cascade    0013
--   message.author_id             cascade    0020
--   message.removed_by            set null   0023
--   suspension.person_id          cascade    0023
--   suspension.suspended_by       set null   0023
--   message_removal.message_id    cascade from message (0023) — a deleted author's originals go too
--
-- ---------------------------------------------------------------------------------------------
-- THE CHAIN THE ISSUE DID NOT LIST
-- ---------------------------------------------------------------------------------------------
--
-- A skipper's match hangs off post, post off boat, boat off person — and 0006 made boat cascade.
-- So deleting a skipper deleted their boats, every post on them and every match on those posts
-- before match's own rule could fire; 0008's header left exactly this to the deletion story.
--
-- Owner decision at pickup (2026-09-20): boat.owner_id becomes nullable, on delete set null, and
-- NO post is removed. An ownerless boat is written by nobody — every boat policy is
-- `owner_id = auth.uid()`, which null never satisfies — and offered by nobody, since the boat
-- picker and /boats list by owner; it survives only as the name on rows that already happened,
-- which is what the admin's day screen prints (#38 already renders a skipper it cannot name).
-- The cost the owner accepted rather than a second rule in this file: an open need from a
-- skipper who has left stays on the board until its date passes, answerable by crew and
-- acceptable by nobody (accept_answer joins boat on owner_id = auth.uid(), so it refuses).
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT ADDS
-- ---------------------------------------------------------------------------------------------
--
--   match.skipper_anonymised, match.crew_anonymised
--                       GENERATED columns over `<side> is null`. A match is only ever created
--                       with both parties present (accept_answer, 0008, is the sole writer), so
--                       a null side is a side that was deleted, and a generated column cannot
--                       disagree with the id it derives from the way a trigger-set boolean
--                       could. Granted for select to authenticated by column, as 0008 grants.
--                       The `skipper_id <> crew_id` check passes a null side (a null comparison
--                       is not false), so no constraint needed rewriting.
--
--   delete_person(person_id)   returns integer — how many match rows now stand anonymised on
--                       the person's account, so the caller can say so.
--
--                       Security DEFINER because `authenticated` holds no delete on person (0002)
--                       and must not gain one: the only route to a deletion is through the check
--                       here, which takes the caller from auth.uid() — the person themself, or
--                       an admin — and refuses a third person with 42501. A person who does not
--                       exist is refused too (no_data_found): nothing to delete is not a success,
--                       and the action that calls this must not go on to delete the auth user.
--
--                       person_contact is deleted EXPLICITLY, first, and not left to 0002's
--                       cascade. The PII is the whole point of the story, and this very file
--                       changes two other tables' delete rules; a later file changing 0002's would
--                       otherwise keep the email and phone with nothing red. notification_log's
--                       to_email is blanked for the same reason: 0010 keeps the row (a send that
--                       happened is a count the cap reads) and nulls person_id, but the address
--                       in the row IS the person's email, and a deletion that left it would not
--                       be one. Everything else is the table above, by cascade.
--
--                       The `not signed in` guard is redundant and kept: with auth.uid() null the
--                       caller is distinct from any person and is_admin() is false, so the next
--                       check refuses anyway (measured: removing it reddens nothing). It stays
--                       because it names the case, as every definer here does.
--
--                       Every use of the parameter is qualified as delete_person.person_id:
--                       person_contact carries a column of that name, and a bare name inside a
--                       function body resolves to the column first (cairn:
--                       postgres-sql-function-parameter-shadowing-2026-08-21). plpgsql's
--                       #variable_conflict = error turns that ambiguity into a run-time error
--                       rather than a silent degeneration, which is what AC 5's mutation measures.
--
--   set_match_status()  REPLACED, body otherwise 0021's, with `is distinct from` in its two party
--                       checks. 0021 wrote `v_caller <> v_match.crew_id`, which against a null
--                       side is NULL — not true — so the `if` did not raise and any signed-in
--                       member could have confirmed on behalf of a crew who had left. Unreachable
--                       until a side could be null, which is this file; fixed in this file.
--
-- ---------------------------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------------------------
--
-- `authenticated`: execute on delete_person, select on the two flags. Nothing new on boat.
-- `anon`: nothing, by name — the hosted project grants anon execute on every new function at
-- creation and the local image does not (cairn: postgrest-probing-a-live-project §4). Since 0015
-- the `anon` half of that revoke is ceremonial and the `public` half is load-bearing; the line is
-- kept whole because every file carries it and 0015's default could move.
-- `service_role`: nothing. The account action calls delete_person as the PERSON, through their
-- cookie-bound client, so the database decides who may delete whom; the service role's only part
-- is the auth user afterwards, and that is GoTrue's table, not this schema's.

-- ---------------------------------------------------------------------------------------------
-- match: both sides nullable, set null on delete, flagged.
-- ---------------------------------------------------------------------------------------------

alter table public.match alter column skipper_id drop not null;
alter table public.match alter column crew_id drop not null;

alter table public.match drop constraint match_skipper_id_fkey;
alter table public.match add constraint match_skipper_id_fkey
  foreign key (skipper_id) references public.person (id) on delete set null;

alter table public.match drop constraint match_crew_id_fkey;
alter table public.match add constraint match_crew_id_fkey
  foreign key (crew_id) references public.person (id) on delete set null;

alter table public.match add column skipper_anonymised boolean not null generated always as (skipper_id is null) stored;
alter table public.match add column crew_anonymised boolean not null generated always as (crew_id is null) stored;

grant select (skipper_anonymised, crew_anonymised) on public.match to authenticated;

-- ---------------------------------------------------------------------------------------------
-- boat: an owner who leaves does not take the boat's history with them.
-- ---------------------------------------------------------------------------------------------

alter table public.boat alter column owner_id drop not null;

alter table public.boat drop constraint boat_owner_id_fkey;
alter table public.boat add constraint boat_owner_id_fkey
  foreign key (owner_id) references public.person (id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- delete_person(): the one route to a deletion.
-- ---------------------------------------------------------------------------------------------

create function public.delete_person(person_id uuid) returns integer
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_kept   integer;
begin
  if v_caller is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_caller is distinct from delete_person.person_id and not public.is_admin() then
    raise exception 'only the person themself or an admin may delete a person' using errcode = '42501';
  end if;
  if not exists (select 1 from public.person p where p.id = delete_person.person_id) then
    raise exception 'no such person' using errcode = 'no_data_found';
  end if;

  -- Counted before the delete, while the ids still name them.
  select count(*)::integer into v_kept
    from public.match m
   where m.skipper_id = delete_person.person_id
      or m.crew_id = delete_person.person_id;

  -- The PII first and by name (see the header), then the person, whose cascade takes the rest.
  -- The log row stays and loses the address; person_id goes null by 0010's rule on the delete.
  update public.notification_log nl set to_email = null where nl.person_id = delete_person.person_id;
  delete from public.person_contact pc where pc.person_id = delete_person.person_id;
  delete from public.person p where p.id = delete_person.person_id;

  return v_kept;
end
$$;

revoke all on function public.delete_person(uuid) from public, anon;
grant execute on function public.delete_person(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- set_match_status(): 0021's body, with the party checks made null-safe.
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_match_status(match_id uuid, status text) returns text
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

  -- `is distinct from`, not `<>`: a side deleted under 0027 is null, and `<>` against null is
  -- null, which an `if` reads as "do not raise" — the wrong direction for a refusal.
  if set_match_status.status = 'confirmed' then
    if v_caller is distinct from v_match.crew_id then
      raise exception 'only the crew confirms' using errcode = '42501';
    end if;
    if not public.on_race_day(v_starts, now()) then
      raise exception 'confirm on the race day';
    end if;
  else
    if v_caller is distinct from v_match.skipper_id then
      raise exception 'only the skipper records sailed or no-show' using errcode = '42501';
    end if;
    if now() <= v_starts then
      raise exception 'sailed and no-show are recorded after the start';
    end if;
  end if;

  -- The trigger decides whether the transition is legal, and raises if not.
  update public.match set status = set_match_status.status where id = set_match_status.match_id;
  -- Returns the status the row HAD, not the one asked for — see 0021 for why the caller needs it.
  return v_match.status;
end
$$;
