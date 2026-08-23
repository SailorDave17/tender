-- 0008 — a match: the skipper accepts one answer, and contact is revealed to both (story #21).
--
-- Numbered per the filing plan (0003 is #16's invite-code rotation and may land after this
-- file). **Paste order: 0002, 0004, 0005, 0006, 0007, then this** — match references post (0006)
-- and person (0002); accept_answer() below reads answer (0007) and boat (0006); and the
-- person_contact policy replaced at the bottom names match, which must exist first.
--
--   match   one per post (post_id is unique): the skipper who accepted, the crew accepted, and
--           when. status is the charter's state list (accepted → confirmed → sailed | no-show)
--           with only 'accepted' written here; the confirm and no-show stories move it. No
--           client role may write this table — it is written by accept_answer() only, so a row
--           can exist only because a skipper accepted a live answer on their own post.
--
-- The skipper chooses, the engine never assigns (charter §Scope): accept_answer() takes the
-- person the skipper picked and refuses anyone who has not answered or has withdrawn.
--
-- Who sees a match: every signed-in person, on a post they can read — the board shows a crewed
-- boat with both names, and names are public already (person, 0002). What a match reveals is
-- CONTACT, and only to its two parties: person_contact's select policy becomes "self OR the
-- counterparty of a match on this row's person", pure RLS with no definer in the read path.
-- That is ADR 003's kill condition — "an RLS policy that cannot express the contact-on-match
-- rule without a security definer escape" — and it did not fire (docs/adr/003 records it).
--
-- On delete: match cascades from post, which cascades from boat, which cascades from person,
-- as 0006 and 0007 already do. The charter's "past matches stay as anonymised rows" when a
-- person is deleted is the deletion story's to build across that whole chain; nothing here
-- decides it.

create table public.match (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null unique references public.post (id) on delete cascade,
  skipper_id  uuid not null references public.person (id) on delete cascade,
  crew_id     uuid not null references public.person (id) on delete cascade,
  status      text not null default 'accepted'
              check (status in ('accepted', 'confirmed', 'sailed', 'no_show')),
  accepted_at timestamptz not null default now(),
  check (skipper_id <> crew_id)
);

alter table public.match enable row level security;

revoke all on public.match from anon, authenticated;
grant select (id, post_id, skipper_id, crew_id, status, accepted_at) on public.match to authenticated;
-- No insert, update or delete grant to any client role: accept_answer() is the only writer.

-- Readable wherever the post is: the subquery runs as the caller and inherits post's read
-- policy (published dates only), so a match on a post the caller cannot see is absent too.
create policy match_read_with_post on public.match
  for select to authenticated
  using (exists (select 1 from public.post p where p.id = match.post_id));

-- ---------------------------------------------------------------------------------------------
-- accept_answer(post_id, person_id): the skipper accepts one of the crew who answered. Security
-- DEFINER because it writes two tables atomically (a match row, the post's closed_at) and
-- authenticated holds no insert on match by design — the only route to a match row is through
-- the checks here. The skipper is auth.uid(), never an argument: a caller cannot accept on
-- someone else's behalf.
--
-- Checks, each raising 42501 so the client sees a refusal and not a row: the caller owns the
-- post's boat; the named person has an un-withdrawn answer on the post. Accepting the same
-- post twice raises 23505 from the unique on post_id — one match per post, the first stands.
-- A post the skipper closed by hand may still be accepted (the answer is live, the skipper
-- changed their mind); closed_at keeps its first value in that case.
--
-- Every parameter is qualified as accept_answer.param: both tables read here carry columns
-- named post_id and person_id, and a bare name inside a function body resolves to the column
-- first (cairn: postgres-sql-function-parameter-shadowing-2026-08-21). plpgsql's default
-- #variable_conflict = error would raise on the ambiguity rather than silently degenerate
-- the way a `language sql` body does — the qualification is kept anyway, so the body does not
-- depend on that default and reads as what it means.
-- ---------------------------------------------------------------------------------------------

create function public.accept_answer(post_id uuid, person_id uuid) returns uuid
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_skipper uuid := auth.uid();
  v_match   uuid;
begin
  if v_skipper is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.post p join public.boat b on b.id = p.boat_id
     where p.id = accept_answer.post_id and b.owner_id = v_skipper
  ) then
    raise exception 'not your post' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.answer a
     where a.post_id = accept_answer.post_id
       and a.person_id = accept_answer.person_id
       and a.withdrawn_at is null
  ) then
    raise exception 'no open answer from that person on this post' using errcode = '42501';
  end if;
  insert into public.match (post_id, skipper_id, crew_id)
    values (accept_answer.post_id, v_skipper, accept_answer.person_id)
    returning id into v_match;
  update public.post set closed_at = coalesce(closed_at, now()) where id = accept_answer.post_id;
  return v_match;
end
$$;

revoke all on function public.accept_answer(uuid, uuid) from public;
grant execute on function public.accept_answer(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- person_contact: self OR counterparty. Replaces 0002's self-only policy — the one select
-- policy 0002's comment said this story would widen. Pure RLS: the subquery runs as the
-- caller over match, which authenticated reads under match_read_with_post, so a match on a
-- post the caller cannot see reveals nothing here either. The row's own column is qualified
-- as person_contact.person_id because match carries no column of that name today and a bare
-- name would start meaning something else the day one is added.
-- ---------------------------------------------------------------------------------------------

drop policy person_contact_read_self on public.person_contact;

create policy person_contact_read_self_or_counterparty on public.person_contact
  for select to authenticated
  using (
    person_contact.person_id = auth.uid()
    or exists (
      select 1 from public.match m
       where (m.skipper_id = auth.uid() and m.crew_id = person_contact.person_id)
          or (m.crew_id = auth.uid() and m.skipper_id = person_contact.person_id)
    )
  );
