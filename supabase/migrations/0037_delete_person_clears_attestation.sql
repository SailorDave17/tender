-- 0037 — deleting a person also clears the 18+ attestation on their auth user, in the same
-- transaction (story #263).
--
-- **Apply after 0036**, which put the attestation in raw_app_meta_data for every member, and after
-- 0033, whose delete_person() body this file replaces. In numeric order after 0036 is the expected
-- path. It replaces a function and creates nothing, so the rule that 0015 and 0016 go last does not
-- reach it.
--
-- ---------------------------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------------------------
--
-- Deleting your own account is two steps (src/profile/delete-account.ts): delete_person() removes
-- the rows as the person, then the service role asks GoTrue to delete the auth user. When that
-- second request is refused (1 in 477 service-key requests on 2026-09-22, #198) the rows are gone
-- and the auth user is not, and since #267 its app_metadata still carries `adult_attested_at`.
-- src/auth/person.ts reads exactly that as "came through the invite gate, finish them": a reset
-- link (/auth/callback), a Google sign-in, or a sign-up through /api/join then minted a NEW, empty
-- person row for the member who had just left, with no invite code asked on the first two.
--
-- An attested auth user with no row is also how two legitimate cases look — a sign-up interrupted
-- between its two writes (#204) and a member from before #99 who never opened their link — and
-- those SHOULD be finished. What tells a deleted account apart is that it had a row once. So the
-- deletion clears the attestation as it removes the row, and the leftover becomes what a stray
-- already is: ensurePerson deletes it at the next reset or Google sign-in, and a sign-up with this
-- season's code makes a new member, as it would after a complete deletion (owner decisions at
-- pickup, 2026-10-11).
--
-- In the function rather than in the application (owner decision at pickup): a service-role call
-- to clear it before the auth delete would fail in the same moments the auth delete does. Here it
-- commits with the row deletes or not at all, and needs no second request.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES
-- ---------------------------------------------------------------------------------------------
--
--   delete_person()   REPLACED, body otherwise 0033's, with one statement added after the person
--                     delete: `adult_attested_at` is removed from the auth user's
--                     raw_app_meta_data. `-` drops that one key, so `provider`, `providers` and
--                     anything else GoTrue keeps there stay. raw_user_meta_data is not touched;
--                     nothing has read an attestation from it since #267.
--
--                     It runs for every caller the function admits, the person or an admin, since
--                     the question is what a deletion removes and not who asked. A refusal raises
--                     before it, so a refused call still leaves everything as it was, attestation
--                     included.
--
--                     The function is a security definer owned by `postgres`, which holds UPDATE
--                     on auth.users (read on the live project 2026-10-11, and the role 0036's
--                     backfill ran as). `create or replace` keeps the owner and the grants, so
--                     0027's `revoke … from public, anon` and `grant execute … to authenticated`
--                     still stand.
--
-- Deleting the auth user any other way (the dashboard, `delete from auth.users`) takes the
-- metadata with it, so this file has nothing to add there.
--
-- No backfill: read 2026-10-11, the live project has 0 auth users with no person row that carry
-- the attestation in raw_app_meta_data, so no earlier partial deletion is waiting to be cleared.
--
-- verify:migrations reads a function by name and argument count, so it reports this file applied
-- before it is. Its read-back is pg_get_functiondef(delete_person) carrying `adult_attested_at`.

create or replace function public.delete_person(person_id uuid) returns integer
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

  -- The PII first and by name (see 0027's header), then the person, whose cascade takes the rest.
  -- The send log is 0033's person_blank_log trigger's, which fires on this delete as on any other.
  delete from public.person_contact pc where pc.person_id = delete_person.person_id;
  delete from public.person p where p.id = delete_person.person_id;

  -- 0037 (#263): the auth user may outlive this call — the auth delete that follows can be
  -- refused — and an attestation left on it would let a reset or a Google sign-in mint a new row.
  update auth.users u
     set raw_app_meta_data = u.raw_app_meta_data - 'adult_attested_at'
   where u.id = delete_person.person_id;

  return v_kept;
end
$$;
