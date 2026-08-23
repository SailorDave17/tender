-- 0009 — the club's configured admin becomes admin on sign-in (story #64).
--
-- **Paste after 0008**, in numeric order: the trigger on person_contact needs 0002, and the one
-- on club needs 0001. Both are `language plpgsql` and resolve their tables at call time, so a
-- paste out of order would succeed and fail at the first sign-in instead
-- (cairn: a-dropped-table-does-not-drop-its-readers).
--
-- Why: PR #62 was promoted to `release` before any person.is_admin had been set, and nothing
-- in the repo sets the first one — /admin answered 404 to everyone until a hand `update` in
-- the SQL editor. A step that exists only in prose is the one that gets skipped
-- (cairn: a-default-is-not-a-decision-2026-08-21). So the admin is a fact about the CLUB ROW —
-- the one thing the owner already seeds by hand — and two triggers hold it from both sides:
--
--   person_contact, after insert         the admin signs in for the first time through the
--                                        invite gate: their contact row arrives carrying the
--                                        email, and if it matches club.admin_email the person
--                                        row is flagged before the callback's redirect lands.
--   club, after insert or update of      the email is set (or changed) after the admin already
--   admin_email                          has a person row — the live project on 2026-08-23 — so
--                                        setting admin_email on the seeded club row is the
--                                        whole bootstrap, with no SQL against person at all.
--
-- Grant only, never revoke: changing or removing an admin is a different story, and a trigger
-- that also cleared the flag would turn a typo in admin_email into a locked-out club. Matching
-- is case-insensitive — the invite gate lowercases the address it stores (src/auth/join.ts),
-- the owner types the seed by hand, and an email's local part is compared case-insensitively
-- everywhere a person would expect it to be.
--
-- Why a trigger rather than code in the callback: the flag must hold against every write path
-- that will ever create a contact row (the invite gate today, an invite-by-email story, a CSV
-- import later), and only the database sees all of them. Both functions are `security definer`
-- with search_path pinned and execute revoked from every client role: a trigger fires without
-- the caller holding execute on its function, and no client role holds update on
-- person.is_admin (0002 grants update on display_name alone) or any write on person_contact, so
-- the only way in is an insert the server makes as service_role after the magic link is
-- exchanged. There is nothing a signed-in person can write that reaches either function.
--
-- Neither function takes a parameter, so there is nothing for a column name to shadow; `new`
-- is the only name in scope besides the tables (cairn: postgres-sql-function-parameter-
-- shadowing-2026-08-21).

-- Nullable: a club row may exist before anyone has decided who the admin is, and NULL matches
-- nobody. 0002's column grant on club names its columns, so the new one is withheld from every
-- client role until a story needs it — nothing in src/ reads the club row as a person today.
alter table public.club
  add column admin_email text check (position('@' in admin_email) > 1);

create function public.admin_from_contact() returns trigger
  language plpgsql security definer
  set search_path = ''
as $$
begin
  update public.person p
     set is_admin = true
    from public.club k
   where p.id = new.person_id
     and k.admin_email is not null
     and lower(k.admin_email) = lower(new.email)
     and not p.is_admin;
  return null;
end
$$;

create function public.admin_from_club() returns trigger
  language plpgsql security definer
  set search_path = ''
as $$
begin
  update public.person p
     set is_admin = true
    from public.person_contact c
   where c.person_id = p.id
     and new.admin_email is not null
     and lower(c.email) = lower(new.admin_email)
     and not p.is_admin;
  return null;
end
$$;

revoke all on function public.admin_from_contact() from public, anon, authenticated;
revoke all on function public.admin_from_club() from public, anon, authenticated;

create trigger person_contact_admin_from_club
  after insert on public.person_contact
  for each row execute function public.admin_from_contact();

create trigger club_admin_email_grants_admin
  after insert or update of admin_email on public.club
  for each row execute function public.admin_from_club();
