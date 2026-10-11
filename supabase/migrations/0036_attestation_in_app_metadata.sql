-- 0036 — every member's 18+ attestation is copied into the field only the service role writes (story #267).
--
-- **Apply after 0002**, which creates public.person and its adult_attested_at column. In numeric
-- order after 0035 is the expected path. It creates no table and no function, so the rule that
-- 0015 and 0016 go last does not reach it.
--
-- ---------------------------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------------------------
--
-- GoTrue keeps two metadata objects on an auth user. `user_metadata` (raw_user_meta_data) is set
-- by the user: at sign-up through `options.data`, and afterwards through `updateUser({ data })`,
-- with nothing but the public anon key and their own session. `app_metadata` (raw_app_meta_data)
-- is written only through the admin API, with the service role. Until #267 the invite gate wrote
-- the 18+ attestation into user_metadata, and src/auth/person.ts decided membership from it, so
-- with *Allow new users to sign up* ON a user could write the attestation about themselves and be
-- admitted without the season's invite code. The application now writes and reads the attestation
-- in app_metadata only (src/auth/person.ts, attestationOf).
--
-- This file is the one-time backfill for the auth users that already exist.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES
-- ---------------------------------------------------------------------------------------------
--
--   auth.users.raw_app_meta_data   gains `adult_attested_at` for every auth user that has a
--                                  public.person row and does not carry the key already.
--
--   The SOURCE is public.person.adult_attested_at, never raw_user_meta_data. The person column was
--   written by the service role when the row was minted (0002 grants no client role an insert on
--   person, and column grants refuse the member an update of it), so it is a fact the server
--   recorded. Copying the user-writable field across would carry forward exactly the value this
--   story stops trusting.
--
--   The VALUE is formatted the way the application writes it, `Date.prototype.toISOString()`
--   (`2026-08-22T12:00:00.000Z`), so a backfilled attestation and a freshly written one cannot be
--   told apart by attestationOf or by anyone reading the dashboard.
--
--   `||` merges one key into the object: `provider`, `providers` and any other key GoTrue keeps in
--   raw_app_meta_data stay as they were. raw_user_meta_data is not touched, so the old copy of the
--   attestation stays where it was, inert, and nothing that reads names out of it changes.
--
--   Auth users with NO person row are left alone, attested in user_metadata or not. Such a user is
--   either a sign-up interrupted between its two writes (#204) or one that arrived with an
--   attestation it wrote itself, and this file cannot tell the two apart. Either way the gate
--   still finishes them: signing up again proves the code and writes the attestation afresh.
--
-- Re-runnable: the `is null` filter makes a second run match nothing, and it never overwrites an
-- attestation the gate has already written into app_metadata.
--
-- This is an UPDATE against existing rows, so verify:migrations reports it as a data backfill with
-- nothing a catalog read can confirm. Its read-back is a count: person rows whose auth user lacks
-- the key in raw_app_meta_data, which is 0 after this file runs.

update auth.users u
   set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object(
            'adult_attested_at',
            to_char(p.adult_attested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
  from public.person p
 where p.id = u.id
   and (u.raw_app_meta_data ->> 'adult_attested_at') is null;
