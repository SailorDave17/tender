-- 0023 — moderation: the admin reads any thread, removes a message, suspends a person (story #36).
--
-- Numbered by arrival, not by the filing plan: the plan said 0013, which #29 consumed for
-- `push_subscription` (0013_push_subscription.sql), and the directory now runs to 0022. The story
-- takes the next free number, which is the overlay's standing rule since #23 shipped as 0010
-- against a filed 0009. The issue body carries the renumber note. **Apply order: after 0022**, in
-- numeric order; 0004 (is_admin), 0006 (post), 0007 (answer) and 0020 (message) must already be
-- applied — the policies below name all four, and `is_suspended()` is a `language sql` body, so
-- `suspension` must exist before it (it does: same file, earlier statement).
--
-- Apply it BEFORE promoting the `develop` that carries #36. From that deployment on, the thread
-- page reads `suspension` and every thread read names `removed_at`; /admin/threads and
-- /admin/people read `message_removal` and `suspension`. Without this file those reads fail and
-- the pages error — loud, but a broken thread page for every matched pair until it lands.
--
-- The shape is owner decision F (2026-08-22, epic #7): moderation at its strongest — the admin
-- removes a message AND can suspend a person.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT ADDS
-- ---------------------------------------------------------------------------------------------
--
--   message_read_admin   a second SELECT policy on `message`, permissive, so it ORs with 0020's
--                        party policy: the admin reads every thread; a signed-in person who is
--                        neither a party nor the admin still reads nothing.
--
--   message.removed_by   who removed it. `removed_at` has existed since 0020 with nothing
--                        setting it; `remove_message()` below is the one writer of both.
--
--   message_removal      the ORIGINAL body of a removed message, readable by the admin alone.
--                        Owner decision at pickup (2026-09-18): removal MOVES the body out of
--                        `message` rather than hiding it on the page. `message_read_parties`
--                        hands both parties every column of every row in their thread, so a
--                        body left in place would still be one PostgREST call away from the
--                        person it was removed to protect — render-time hiding is not a
--                        boundary, which is the rule 0020's own header states for the length
--                        cap. What stays in `message.body` is the sentence both parties are
--                        shown, so even a raw read of the table says the true thing.
--
--   remove_message(message_id)   security DEFINER, because `authenticated` holds no update on
--                        `message` (0020) and must not gain one: an update grant is exactly
--                        the edit path AC 3 forbids the author. Admin-gated by raising 42501,
--                        like current_invite_code(). Idempotent: a second call on a removed
--                        message changes nothing and keeps the first original.
--
--   suspension           one row per suspended person. A table rather than a column on
--                        `person` because `person`'s read policy is club-wide (0002) and a
--                        column grant cannot be narrowed per row: a `suspended_at` there would
--                        tell every member who is suspended. Here the person reads their own
--                        row (for the one-line notice at sign-in) and the admin reads all.
--                        Suspending is an insert, lifting is a delete — both the admin's, both
--                        ordinary RLS, no definer.
--
--   is_suspended()       security INVOKER, like is_admin(): it reads the caller's own row, which
--                        the caller may read, so it needs no privilege its caller lacks.
--
--   four RESTRICTIVE policies   the suspension clause on post, answer and message writes. A
--                        restrictive policy ANDs with the permissive ones already there, so
--                        0006's, 0007's and 0020's rules are untouched and each table gains
--                        exactly one clause. Withdrawing an answer and closing a post stay
--                        allowed: AC 4 stops a person posting, answering and messaging, and
--                        "suspension hides nothing already written" — a suspended person taking
--                        their own answer back is fewer words from them, not more.
--
-- A security DEFINER bypasses RLS, so the restrictive clauses do not reach one. The definers that
-- write these three tables: none. `accept_answer()` (0008) writes `match` and `post.closed_at`,
-- neither of which AC 4 names; a suspended skipper can still accept an answer and cannot then
-- message the crew. Recorded rather than widened: that is the issue's scope.

-- ---------------------------------------------------------------------------------------------
-- message: the admin's read, and who removed it.
-- ---------------------------------------------------------------------------------------------

alter table public.message add column removed_by uuid references public.person (id) on delete set null;

-- Select on the new column for the same reason 0020 grants every column: a column withheld from
-- the select grant is refused wherever a statement NAMES it, with an error naming the table.
-- Nothing is granted for insert or update — the definer is the only writer.
grant select (removed_by) on public.message to authenticated;

create policy message_read_admin on public.message
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------------------------
-- message_removal: the original body, the admin's alone.
-- ---------------------------------------------------------------------------------------------

create table public.message_removal (
  message_id uuid primary key references public.message (id) on delete cascade,
  body       text not null,
  removed_at timestamptz not null default now()
);

alter table public.message_removal enable row level security;

revoke all on public.message_removal from anon, authenticated;
grant select (message_id, body, removed_at) on public.message_removal to authenticated;
-- No insert, update or delete to any client role: remove_message() writes it as its owner, and
-- a person deleted on request takes their messages and these rows with them by cascade.

create policy message_removal_read_admin on public.message_removal
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------------------------
-- remove_message(): the one way a message is removed.
--
-- The parameter is qualified as remove_message.message_id: `message_removal` carries a column of
-- that name, and a bare name inside a function body resolves to the column first (cairn:
-- postgres-sql-function-parameter-shadowing-2026-08-21). plpgsql's default #variable_conflict =
-- error would raise rather than degenerate; the qualification is kept anyway so the body does not
-- depend on that default.
--
-- The UPDATE carries a WHERE, which Supabase's `safeupdate` requires of every statement on the
-- authenticator's session (the #16 trap: pglite and psql both accept a bare UPDATE).
-- ---------------------------------------------------------------------------------------------

create function public.remove_message(message_id uuid) returns void
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_body    text;
  v_removed timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  select m.body, m.removed_at into v_body, v_removed
    from public.message m
   where m.id = remove_message.message_id
     for update;
  if not found then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  -- Already removed: the original is already kept, and the body is already the notice. A second
  -- call copying the notice over the original would destroy the one record of what was said.
  if v_removed is not null then
    return;
  end if;
  insert into public.message_removal (message_id, body) values (remove_message.message_id, v_body);
  update public.message
     set body = 'Removed by the club admin', removed_at = now(), removed_by = auth.uid()
   where id = remove_message.message_id;
end
$$;

revoke all on function public.remove_message(uuid) from public, anon;
grant execute on function public.remove_message(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- suspension: who may no longer post, answer or message.
-- ---------------------------------------------------------------------------------------------

create table public.suspension (
  person_id    uuid primary key references public.person (id) on delete cascade,
  suspended_at timestamptz not null default now(),
  -- `on delete set null` with no check tying it to suspended_at: suspended_at is never null, so
  -- the asymmetric form (cairn: a-symmetric-check-on-a-set-null-pair-refuses-the-delete) has
  -- nothing to guard, and the admin's own deletion must not take their suspensions with it.
  suspended_by uuid references public.person (id) on delete set null
);

alter table public.suspension enable row level security;

revoke all on public.suspension from anon, authenticated;
grant select (person_id, suspended_at, suspended_by) on public.suspension to authenticated;
-- suspended_at is the database's; suspended_by is supplied and then held to auth.uid() below, so
-- a suspension cannot be attributed to someone else.
grant insert (person_id, suspended_by) on public.suspension to authenticated;
grant delete on public.suspension to authenticated;

create policy suspension_read_self_or_admin on public.suspension
  for select to authenticated
  using (person_id = auth.uid() or public.is_admin());

create policy suspension_insert_admin on public.suspension
  for insert to authenticated
  with check (public.is_admin() and suspended_by = auth.uid());

create policy suspension_delete_admin on public.suspension
  for delete to authenticated
  using (public.is_admin());

create function public.is_suspended() returns boolean
  language sql stable
  set search_path = ''
as $$
  select exists (select 1 from public.suspension s where s.person_id = auth.uid())
$$;

-- By name from anon: the hosted project grants anon execute on every new function directly,
-- which 0015's default-privileges revoke cannot reach (cairn: postgrest-probing-a-live-project §4).
revoke all on function public.is_suspended() from public, anon;
grant execute on function public.is_suspended() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The suspension clause: one restrictive policy per write AC 4 names.
-- ---------------------------------------------------------------------------------------------

create policy post_insert_not_suspended on public.post
  as restrictive
  for insert to authenticated
  with check (not public.is_suspended());

create policy answer_insert_not_suspended on public.answer
  as restrictive
  for insert to authenticated
  with check (not public.is_suspended());

-- Answering again is an UPDATE (withdrawn_at back to null, 0007), so the clause has to be here as
-- well as on insert or a suspended crew re-answers through the back door. Withdrawing — the new
-- row carries a withdrawn_at — stays allowed.
create policy answer_update_not_suspended on public.answer
  as restrictive
  for update to authenticated
  using (true)
  with check (withdrawn_at is not null or not public.is_suspended());

create policy message_insert_not_suspended on public.message
  as restrictive
  for insert to authenticated
  with check (not public.is_suspended());
