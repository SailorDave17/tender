-- 0031 — person.profile_completed_at: has this member finished their profile (story #219).
--
-- **Apply in numeric order, after 0030.** It alters person (0002) and grants on it; nothing
-- else is a prerequisite.
--
-- WHY. Owner decision 2026-09-22: sign-up creates the account first, and the member says who they
-- are on a separate screen once the account exists (`/welcome`, "Finish your profile"). The proxy
-- sends a signed-in member whose `profile_completed_at` is null to that screen from every gated
-- path (src/auth/gate.ts), and a member who has finished away from it. This column is the one
-- fact that decides which.
--
-- WHY `default now()`, AND WHY THAT IS THIS STORY'S DEFAULT RATHER THAN THE PRODUCT'S. The
-- default does two jobs. It backfills: `add column … default now()` gives every EXISTING row the
-- migration's instant, so no member who already has an account is ever sent to /welcome (AC 1).
-- And it keeps every row created from here on finished, which is correct until the sign-up rework
-- (#220) lands, because today's sign-up form still asks for the name before the account exists —
-- a member who typed their name there has nothing left to finish. #220 is the story that stops
-- asking, and it must then insert `profile_completed_at` as an explicit NULL in BOTH person
-- writers (src/lib/auth/person-store.ts and /api/join's inline store). Until it does, the only way
-- to see /welcome is to clear this column by hand, which the issue states.
--
-- WHO WRITES IT. The service role (the invite gate's insert, through the default above), and the
-- member themselves through /welcome's Server Action, under the same `person_update_self` policy
-- (0002) that already confines every client write on person to the caller's own row — so an
-- update naming someone else's id matches zero rows (AC 4). The column grant admits this column
-- and the name; is_admin and adult_attested_at stay refused at the grant.
--
-- WHO READS IT. Every signed-in member, like `created_at` beside it: person's read policy is
-- club-wide (0002) and a column grant applies to every row, so this is the same exposure as
-- "when you joined", which /privacy already states. The proxy reads the caller's own row with it.

alter table public.person add column profile_completed_at timestamptz default now();

grant select (profile_completed_at) on public.person to authenticated;
grant update (profile_completed_at) on public.person to authenticated;
