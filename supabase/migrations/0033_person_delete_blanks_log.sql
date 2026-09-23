-- 0033 — every deletion of a person blanks their addresses in the send log, not only delete_person()
-- (story #201).
--
-- Numbered by arrival: the story asked for "the next free number after 0029", and 0030–0032 went
-- to #198, #219 and #206 before it was picked up. **Apply after 0029**, whose delete_person() body
-- this file replaces; 0010 (notification_log) and 0002 (person) must already be applied, as they
-- are for 0027. In numeric order after 0032 is the expected path.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT 0027 AND 0029 LEFT TO ONE ROUTE
-- ---------------------------------------------------------------------------------------------
--
-- delete_person() blanked the person's notification_log.to_email (0027) and nulled provider_id on
-- their push rows (0029) before deleting the person row. The database did that only inside the
-- function. public.person cascades from auth.users (0002), so deleting the auth user any other way
-- — Authentication → Users in the dashboard, a raw `delete from auth.users`, GoTrue's admin API —
-- removed the person with neither statement run. person_id then went null by 0010's rule and the
-- rows kept the address and the endpoint with nothing left to find them by. The README's runbook
-- step 6 spelled the two statements out for the owner to run by hand first; a skipped step left
-- no trace, while /privacy promised every route what the function did.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES
-- ---------------------------------------------------------------------------------------------
--
--   blank_person_log()   A `before delete` row trigger on public.person. It blanks to_email on
--                        the person's notification_log rows and nulls provider_id on their
--                        `channel = 'push'` rows, while person_id still names them — after the
--                        delete, 0010's set-null has made them nobody's. An email row's
--                        provider_id is Resend's message id, which names a send and not a person,
--                        and stays (0029's rule, unchanged).
--
--                        A row trigger on person fires however the row goes, including as the
--                        cascade from auth.users, which is the whole point.
--
--                        Security DEFINER with search_path pinned (owner decision at pickup, #201
--                        AC 4). The trigger runs as whoever deleted the person, and that is not
--                        one role: the cascade from auth.users runs as person's owner, but a
--                        direct delete by service_role runs as service_role, which holds only
--                        select and insert on notification_log (0010). An invoker body would
--                        refuse that delete with 42501 and make the blanking depend on who
--                        deleted, which is the gap this story closes. As a definer it runs as the
--                        owner of notification_log whoever fires it. Nothing can call it except as
--                        a trigger (it returns `trigger`), and execute is revoked by name as 0009
--                        and 0021 do for theirs.
--
--   delete_person()      REPLACED, body otherwise 0029's, WITHOUT its two notification_log
--                        statements (owner decision at pickup, #201 AC 3: the trigger is the rule,
--                        in one copy). Its `delete from public.person` fires the trigger like any
--                        other route. person_contact is still deleted first and by name, for the
--                        reason 0027 gives. `create or replace` keeps the owner and the grants, so
--                        0027's `revoke … from public, anon` and `grant execute … to authenticated`
--                        still stand; test/delete-person-trigger.test.ts reads them after this file.
--
-- No backfill (owner decision at pickup, #201). 0029 already cleared the push endpoints of every
-- earlier deletion by any route. An email address left by an earlier dashboard deletion cannot be
-- told apart in the log: invite and error rows are written with person_id null and a real address
-- in to_email, so "person_id is null" does not mean "a deleted member". Those rows are left as
-- they are.

create function public.blank_person_log() returns trigger
  language plpgsql security definer
  set search_path = ''
as $$
begin
  -- The address goes from every row of theirs; the row stays (a send that happened is a count the
  -- cap reads). A push row's provider_id is the device's endpoint (0029) and goes too; an email
  -- row's is Resend's message id and stays.
  update public.notification_log nl
     set to_email = null,
         provider_id = case when nl.channel = 'push' then null else nl.provider_id end
   where nl.person_id = old.id;
  return old;
end
$$;

revoke all on function public.blank_person_log() from public, anon, authenticated;

create trigger person_blank_log
  before delete on public.person
  for each row execute function public.blank_person_log();

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

  return v_kept;
end
$$;
