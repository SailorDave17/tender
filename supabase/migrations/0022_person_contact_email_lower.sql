-- 0022 — a case-insensitive index on the members' addresses, and the function that reads it
-- (story #31).
--
-- **Apply after 0021.** It touches only `public.person_contact`, which 0002 creates, and it adds
-- an index and a function — no column, no policy change, no grant to a client role.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS IS FOR
-- ---------------------------------------------------------------------------------------------
--
-- /admin/invite pastes up to fifty addresses and must skip the ones already holding a person row
-- (#31 AC 3). That is one question — "which of these addresses are members?" — and it has to be
-- asked case-insensitively, because a member who signed up as Dave@Example.org is the same person
-- as a paste of dave@example.org.
--
-- PostgREST cannot express it. There is no filter for `lower(col) in (…)`: an `in` on the
-- lowercased list is compared against the STORED spelling and silently misses every mixed-case
-- row, which is the dangerous direction — a missed skip re-invites a member who then hits /join's
-- 409 ("you already have an account"), so the failure lands on the person rather than on the
-- admin. The first cut of this story therefore read every contact row and matched in JavaScript:
-- correct, and proven against a real mixed-case row, but it hands the whole club's addresses to
-- the application to answer a question about fifty of them.
--
-- So the match moves into Postgres, where it belongs (owner decision, 2026-09-18):
--
--   * a functional index on `lower(email)`, which is what makes the lookup a lookup rather than a
--     scan at any club size;
--   * a definer function that takes the addresses and returns only those that match, so the
--     service role reads an answer instead of a table.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A DEFINER FUNCTION AND NOT JUST THE INDEX
-- ---------------------------------------------------------------------------------------------
--
-- The index alone would leave the caller selecting `person_contact` rows and filtering them, which
-- is the same club-wide read with a faster plan. The function is the narrowing: its argument is the
-- addresses the admin already typed, and its result is a subset of them. Nothing about a member who
-- was NOT pasted can be learned from it — there is no way to enumerate the club through it, which
-- is exactly what a `select email from person_contact` gives you.
--
-- `security definer` with `search_path = ''`, the same shape as 0003's invite-code functions: it
-- reads a table whose RLS hides every row from the caller, so it must own the read. Execute is
-- revoked from `public`, `anon` and `authenticated` BY NAME — the hosted project grants `anon`
-- execute on every new function directly and the local image does not
-- (cairn: postgrest-probing-a-live-project §4), so naming the roles is load-bearing rather than
-- tidy. Only `service_role` may call it, and only the invite store does.
--
-- It is NOT `is_admin()`-gated, deliberately. The authorization for the invite send lives in the
-- action (which re-checks `person.is_admin` on the caller's own client, because the store runs as
-- the service role and RLS is bypassed) and in the page's 404. Putting a second, different check
-- in here would imply the function is reachable by a client role, which the revoke above makes
-- false — and a check nobody can reach is a comment, not a guard.

-- ---------------------------------------------------------------------------------------------
-- The index
-- ---------------------------------------------------------------------------------------------

-- Not unique: two people sharing an address is a data question this story does not settle (a
-- household with one inbox is a real case at a sailing club), and a unique index here would refuse
-- the second sign-up at the database with no screen able to explain why.
create index if not exists person_contact_email_lower
  on public.person_contact (lower(email));

-- ---------------------------------------------------------------------------------------------
-- The read
-- ---------------------------------------------------------------------------------------------

-- Returns the members among `p_emails`, lowercased. The caller lowercases what it sends; both
-- sides are lowered here anyway, so the function is correct whatever the caller does with case.
create or replace function public.members_among(p_emails text[])
  returns setof text
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select distinct lower(c.email)
  from public.person_contact c
  where lower(c.email) = any (select lower(e) from unnest(p_emails) e)
$$;

revoke all on function public.members_among(text[]) from public, anon, authenticated;
grant execute on function public.members_among(text[]) to service_role;
