-- 0011 — the competence scale gains a fourth level: "can fly a spinnaker", between hike-and-trim
-- and helm (story #69, owner decision 2026-08-23).
--
-- Paste order: after 0010. Depends on 0005 (person.rating) and 0006 (boat.default_minimum,
-- post.minimum) — this file only widens what those three created.
--
-- The scale is an ORDINAL the engine compares with `<` (src/engine/ladder.ts), so the new level
-- cannot be appended as 4: a spinnaker hand must sort below a helm. Helm therefore moves 3 -> 4
-- and spinnaker takes 3, and every row already storing 3 is renumbered here.
--
--   1 never raced        (unchanged)
--   2 can hike and trim  (unchanged)
--   3 can fly a spinnaker  <- new
--   4 can helm           (was 3)
--
-- THE ORDER IN THIS FILE IS LOAD-BEARING, in both directions:
--
--   * Each check is widened BEFORE its update, because `set rating = 4` fails against the old
--     `in (1, 2, 3)` — the migration would abort with 23514 rather than do half the work.
--   * Each update runs in THIS file and not later, because a row left at 3 does not error: it
--     silently becomes a spinnaker hand. That is the failure with no symptom, and the reason
--     the renumber belongs beside the widening rather than in a follow-up.
--
-- Not touched, deliberately: post.current_rung and suggestion.rung (0010) are the LADDER's rungs
-- — strict / amber / red — a different scale that stays at three. A grep for `in (1, 2, 3)` finds
-- five checks in this schema and only the three below are competence.

-- ---------------------------------------------------------------------------------------------
-- 1. Widen the three checks.
-- ---------------------------------------------------------------------------------------------

alter table public.person
  drop constraint person_rating_check,
  add constraint person_rating_check check (rating in (1, 2, 3, 4));

alter table public.boat
  drop constraint boat_default_minimum_check,
  add constraint boat_default_minimum_check check (default_minimum in (1, 2, 3, 4));

alter table public.post
  drop constraint post_minimum_check,
  add constraint post_minimum_check check (minimum in (1, 2, 3, 4));

-- ---------------------------------------------------------------------------------------------
-- 2. Renumber the existing helms, now that 4 is legal. One statement each, and each is a no-op
--    on a project with no rows at 3 — which is what makes this safe to paste after the fact.
-- ---------------------------------------------------------------------------------------------

update public.person set rating          = 4 where rating          = 3;
update public.boat   set default_minimum = 4 where default_minimum = 3;
update public.post   set minimum         = 4 where minimum         = 3;
