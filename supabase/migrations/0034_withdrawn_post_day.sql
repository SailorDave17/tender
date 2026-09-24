-- 0034 — a post whose race day was unpublished tells its own people so, instead of "Not here"
-- (story #199).
--
-- Numbered by arrival: the next free number after 0033. Needs 0004 (race_date), 0006 (boat, post)
-- and 0007 (answer) applied first — this is a `language sql` body, so Postgres
-- validates every table it names at CREATE. In numeric order after 0033 is the expected path.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------------------------
--
-- 0006's post_read_published admits a post only while its race_date is published, with no clause
-- for anyone in particular. 0007's skipper clause on answer and 0008's match_read_with_post both
-- read post under that policy, and person_contact's counterparty clause and 0020's message policy
-- read match — so unpublishing a date hides the post, its answers, the match, the contact details
-- and the thread from everyone, the post's own skipper included. /post/<id> found no post and
-- called notFound(), and every push already on a phone for that post (src/push/payload.ts's
-- `url: /post/<id>`, `/post/<id>/thread` for a message) landed on "Not here". Found on #134's live pass, 2026-09-22.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES — AND WHAT IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------------------------
--
--   withdrawn_post_day(p_post)   The race day's starts_at, when the post exists, its race date is
--                                NOT published, and the caller is one of the post's own people:
--                                the boat's owner, or anyone with an answer row on it (withdrawn
--                                or not — they were told about it either way). NULL for everything
--                                else, which includes a post that does not exist, a post on a
--                                published date, and a caller who is neither — so a stranger
--                                cannot tell a withdrawn post from a missing one, which is the
--                                property "Not here" already had.
--
-- Both parties to the post's match are covered by those two clauses, so there is no third one for
-- them. The match's skipper is the boat's owner (accept_answer, 0008, takes skipper_id from the
-- caller it has just checked owns the boat, and 0006 lets no one change a boat's owner); its crew
-- holds an answer row on the post (accept_answer refuses anyone without an un-withdrawn one, and no
-- client role holds delete on answer, 0007). A match clause was written and then removed on #199's
-- mutation pass: taking it out reddened nothing, because it could not change the answer. Should
-- either invariant move — a boat transfer, an answer that can be deleted — this is where a match
-- clause goes back.
--
-- No read policy changes (owner decision at pickup, #199: the "withdrawn" sentence route, over an
-- owner read clause and over refusing the unpublish). The post, its answers, the match, contact
-- details and the thread stay hidden while the date is unpublished, for the skipper as for anyone;
-- what the skipper gets back is one fact they already held — that the post was theirs, and which
-- day it was for. Republishing the date brings everything back, since nothing was deleted.
--
-- Security DEFINER because the two membership tests read rows the caller's own policies now hide
-- (that is the defect). Pinned search_path; execute revoked from `public, anon` by name, as 0015
-- requires of every function here, and granted to authenticated.

create function public.withdrawn_post_day(p_post uuid)
  returns timestamptz
  language sql stable security definer
  set search_path = ''
as $$
  select r.starts_at
    from public.post p
    join public.race_date r on r.id = p.race_date_id
    join public.boat b on b.id = p.boat_id
   where p.id = withdrawn_post_day.p_post
     and not r.published
     and (
       b.owner_id = auth.uid()
       or exists (
         select 1 from public.answer a where a.post_id = p.id and a.person_id = auth.uid()
       )
     )
$$;

revoke all on function public.withdrawn_post_day(uuid) from public, anon;
grant execute on function public.withdrawn_post_day(uuid) to authenticated;
