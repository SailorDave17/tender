-- 0029 — a deletion takes the person's device push addresses out of the send log (story #197).
--
-- **Apply after 0027**, which creates delete_person() and whose body this file replaces; 0010
-- (notification_log) must already be applied, as it is for 0027. In numeric order after 0028 is
-- the expected path. It creates no table and no new function, so the rule that 0015 and 0016 go
-- last does not reach it. Found on #147 while checking /privacy's deletion claims against the
-- migrations.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT 0027 LEFT BEHIND
-- ---------------------------------------------------------------------------------------------
--
-- Every push send logs the device's push ENDPOINT in notification_log.provider_id — 12 call
-- sites in src/notify/ (rung, answer, message, and confirm, which also carries the morning-of
-- kinds), each writing `providerId: target.endpoint` with the recipient's person_id. 0027's
-- delete_person() blanks to_email and deletes the person, whose delete nulls person_id by 0010's
-- rule. It never touched provider_id, so each of the person's push rows kept the URL of a device
-- that belonged to someone who asked to be deleted. Inside Tender nothing linked the row back to
-- anyone (the push_subscription row goes by cascade), but an endpoint is a device identifier
-- issued by the browser's push service, and keeping it is not what charter §Data means by a
-- deletion.
--
-- For EMAIL rows provider_id is Resend's message id, which names a send and not a person. Those
-- stay, and the test holds that they do.
--
-- The `error` column does not carry the endpoint either, which is why this file touches one
-- column: src/push/send.ts stores the thrown message, and web-push's own refusal is the fixed
-- string 'Received unexpected response code' (the endpoint is a PROPERTY of WebPushError, not
-- part of its message), while a transport failure names the push service's host at most.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES
-- ---------------------------------------------------------------------------------------------
--
--   delete_person()   REPLACED, body otherwise 0027's, with one statement added: provider_id is
--                     nulled on the person's `channel = 'push'` rows in the same pass that
--                     blanks to_email, and BEFORE the person row goes — after that delete,
--                     person_id is null on every one of those rows and nothing names them.
--                     `create or replace` keeps the function's owner and its grants, so 0027's
--                     `revoke … from public, anon` and `grant execute … to authenticated` still
--                     stand, as 0027's own replace of set_match_status relied on for 0021's;
--                     test/delete-person-push.test.ts reads both grants after this file.
--
--   the backfill      Owner decision at pickup (2026-09-21, #197 AC 3): the same blank for push
--                     rows from deletions made BEFORE this file. The premise is that every push
--                     row is written with a non-null person_id (all 12 call sites pass the
--                     recipient's), so a push row whose person_id is null is one whose person was
--                     deleted — by delete_person(), or by an auth user deleted outside it, whose
--                     cascade through 0002 reaches the same set-null. Email rows are not touched.
--                     Re-runnable: a second run matches nothing.

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
  -- The log row stays and loses the address; person_id goes null by 0010's rule on the delete.
  update public.notification_log nl set to_email = null where nl.person_id = delete_person.person_id;
  -- 0029: a push row's provider_id is the device's endpoint. Nulled while person_id still names
  -- the row; an email row's provider_id is Resend's message id and stays.
  update public.notification_log nl set provider_id = null
   where nl.person_id = delete_person.person_id and nl.channel = 'push';
  delete from public.person_contact pc where pc.person_id = delete_person.person_id;
  delete from public.person p where p.id = delete_person.person_id;

  return v_kept;
end
$$;

-- Deletions made before this file: the owner's decision at pickup, #197 AC 3.
update public.notification_log set provider_id = null
 where channel = 'push' and person_id is null and provider_id is not null;
