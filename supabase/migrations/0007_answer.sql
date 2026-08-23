-- 0007 — a crew's answer to a post: "I can" (story #20).
--
-- Numbered per the filing plan (0003 is #16's invite-code rotation and may land after this
-- file). **Paste order: 0002, 0004, 0005, 0006, then this** — answer references post (0006)
-- and person (0002), and can_answer() below is a `language sql` body, validated at CREATE
-- against post and availability (0005), so a missing prerequisite fails the paste with 42P01.
--
--   answer   one row per person per post (the pair is the key). A row is the crew saying they
--            can; withdrawn_at set is the crew taking it back. The row stays when withdrawn —
--            the skipper may have seen it, and #21's accept_answer() checks for an un-withdrawn
--            one — so there is no delete grant, and answering again after a withdrawal clears
--            withdrawn_at rather than inserting.
--
-- Who sees what (AC 1): a crew reads their own answers; the post's skipper reads every answer
-- on their post; anyone else signed in reads only how many — answer_counts() below, the one
-- security DEFINER function in the schema so far, which returns integers and nothing a row
-- holds. Names, ratings and the rest stay behind the skipper's read policy; contact stays
-- behind person_contact's self-only policy until a match (#21). This is not ADR 003's kill
-- condition (a definer escape for the contact-on-match rule): a count is not a row.
--
-- Who writes: the crew themselves, and only while the post is open and they have marked its
-- race date available — can_answer() below, which is what the page's disabled button stands in
-- for (AC 3): a crafted POST without the availability row is refused here (42501), and an
-- answer on a closed post likewise. The skipper is not stopped from answering their own post
-- by the database; the page never offers it.

create table public.answer (
  post_id      uuid not null references public.post (id) on delete cascade,
  person_id    uuid not null references public.person (id) on delete cascade,
  created_at   timestamptz not null default now(),
  withdrawn_at timestamptz,
  primary key (post_id, person_id)
);

alter table public.answer enable row level security;

revoke all on public.answer from anon, authenticated;
grant select (post_id, person_id, created_at, withdrawn_at) on public.answer to authenticated;
grant insert (post_id, person_id) on public.answer to authenticated;
grant update (withdrawn_at) on public.answer to authenticated;
-- No delete grant: an answer is taken back by withdrawing it, so the record stays.

-- ---------------------------------------------------------------------------------------------
-- can_answer(): may the signed-in person answer this post right now? Security INVOKER, like
-- owns_boat() (0006): post is read under post_read_published as the caller, so a post on a
-- date that has gone unpublished reads as absent here and the answer is refused with it;
-- availability is readable by everyone (0005). The parameter is qualified as
-- can_answer.post_id because answer carries a column of that name and a bare name in a SQL
-- body resolves to a column first (cairn: postgres-sql-function-parameter-shadowing-2026-08-21).
-- ---------------------------------------------------------------------------------------------

create function public.can_answer(post_id uuid) returns boolean
  language sql stable
  set search_path = ''
as $$
  select exists (
    select 1
      from public.post p
      join public.availability a
        on a.race_date_id = p.race_date_id and a.person_id = auth.uid()
     where p.id = can_answer.post_id and p.closed_at is null
  )
$$;

grant execute on function public.can_answer(uuid) to authenticated;

-- Own answers, plus every answer on a post whose boat the caller owns. The subquery runs as
-- the caller and inherits post's and boat's read policies (both read-everyone for a signed-in
-- person, post on published dates only).
create policy answer_read_own_or_skipper on public.answer
  for select to authenticated
  using (
    person_id = auth.uid()
    or exists (
      select 1 from public.post p join public.boat b on b.id = p.boat_id
       where p.id = post_id and b.owner_id = auth.uid()
    )
  );

-- Only oneself, only on an open post one is available for. Refused loudly (42501).
create policy answer_insert_self on public.answer
  for insert to authenticated
  with check (person_id = auth.uid() and public.can_answer(post_id));

-- Withdrawing is always the crew's to do on their own row; answering again (withdrawn_at back
-- to null) is held to the same rule as a first answer. The column grant limits the update to
-- withdrawn_at; a non-owner's update matches zero rows.
create policy answer_update_self on public.answer
  for update to authenticated
  using (person_id = auth.uid())
  with check (person_id = auth.uid() and (withdrawn_at is not null or public.can_answer(post_id)));

-- ---------------------------------------------------------------------------------------------
-- answer_counts(): how many un-withdrawn answers each of the given posts has. Security DEFINER
-- because the count is the one thing a non-skipper may know about other people's answers and
-- no row-level policy can express "rows you may count but not read". It takes the ids the
-- caller already holds — read under post's own policy — rather than enumerating posts, so it
-- reveals nothing about a post the caller could not see; a post id that does not exist, or
-- has no answers, is simply absent from the result. Execute is revoked from PUBLIC (Postgres
-- grants it by default) so anon cannot call it at all, and granted to authenticated only.
-- ---------------------------------------------------------------------------------------------

create function public.answer_counts(post_ids uuid[])
  returns table (post_id uuid, answered integer)
  language sql stable security definer
  set search_path = ''
as $$
  select a.post_id, count(*)::integer as answered
    from public.answer a
   where a.post_id = any (answer_counts.post_ids) and a.withdrawn_at is null
   group by a.post_id
$$;

revoke all on function public.answer_counts(uuid[]) from public;
grant execute on function public.answer_counts(uuid[]) to authenticated;
