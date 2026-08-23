-- 0006 — a skipper's boat and the need it posts against a race date (story #19).
--
-- Numbered per the filing plan (0003 is #16's invite-code rotation and may land after this
-- file). **Paste order: 0002, 0004, 0005, then this** — boat references person (0002) and
-- boat_class (0005), post references race_date (0004).
--
--   boat   owned by a person. Owning a boat is what makes someone a skipper — there is no flag
--          (0002's comment). name, class (one of the fleet list) and the minimum competence the
--          skipper will usually take, which the post form offers as its default.
--   post   a boat needs crew for a race date: the minimum for this day, a note, and closed_at
--          once the skipper withdraws it or a match closes it (#21). One post per boat per date
--          (unique), and the constraint is on the pair, not on open posts only — a closed post
--          holds the slot, so a skipper who closed by mistake cannot re-post that day; that is
--          the AC's shape and the simpler rule, and a later story can relax it if it bites.
--
-- Every signed-in person reads every boat and every post on a published date: the board is
-- always true and curated by nobody (charter §Scope 8). Only the boat's owner writes either.
-- A post's insert is also refused for an unpublished date and for a date already started —
-- the board would never show it and the ladder has nothing to count down to.
--
-- The post's open rung is NOT stored. It is computed on every board read from suggest() over
-- the crew available for that date (src/board/post-view.ts) — ADR 004's lazy-relaxation
-- fallback shipped first, with the persisted monotone rung arriving alongside the notification
-- ledger (#23/#25) where it is first needed.

-- ---------------------------------------------------------------------------------------------
-- boat
-- ---------------------------------------------------------------------------------------------

create table public.boat (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.person (id) on delete cascade,
  name            text not null check (length(name) between 1 and 80),
  class           text not null references public.boat_class (name),
  default_minimum smallint not null check (default_minimum in (1, 2, 3)),
  created_at      timestamptz not null default now()
);

alter table public.boat enable row level security;

revoke all on public.boat from anon, authenticated;
grant select (id, owner_id, name, class, default_minimum, created_at) on public.boat to authenticated;
grant insert (owner_id, name, class, default_minimum) on public.boat to authenticated;
grant update (name, class, default_minimum) on public.boat to authenticated;
grant delete on public.boat to authenticated;

create policy boat_read_authenticated on public.boat
  for select to authenticated using (true);

create policy boat_insert_own on public.boat
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy boat_update_own on public.boat
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy boat_delete_own on public.boat
  for delete to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------------------------
-- post
-- ---------------------------------------------------------------------------------------------

create table public.post (
  id           uuid primary key default gen_random_uuid(),
  boat_id      uuid not null references public.boat (id) on delete cascade,
  race_date_id uuid not null references public.race_date (id) on delete cascade,
  minimum      smallint not null check (minimum in (1, 2, 3)),
  note         text not null default '' check (length(note) <= 280),
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  unique (boat_id, race_date_id)
);

alter table public.post enable row level security;

revoke all on public.post from anon, authenticated;
grant select (id, boat_id, race_date_id, minimum, note, created_at, closed_at) on public.post to authenticated;
grant insert (boat_id, race_date_id, minimum, note) on public.post to authenticated;
grant update (closed_at) on public.post to authenticated;
-- No delete grant: a post is withdrawn by closing it, so the record of the need stays.

-- ---------------------------------------------------------------------------------------------
-- owns_boat(): does the signed-in person own this boat? Security INVOKER, like is_admin()
-- (0004): authenticated reads every boat under boat_read_authenticated, so the function has
-- exactly its caller's view. The parameter is qualified as owns_boat.boat_id because boat
-- carries no column of that name today and post does — a bare name inside a SQL body resolves
-- to a column first (cairn: postgres-sql-function-parameter-shadowing-2026-08-21).
-- ---------------------------------------------------------------------------------------------

create function public.owns_boat(boat_id uuid) returns boolean
  language sql stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.boat b where b.id = owns_boat.boat_id and b.owner_id = auth.uid()
  )
$$;

grant execute on function public.owns_boat(uuid) to authenticated;

-- Published dates only. The subquery runs as the caller, for whom race_date's own policy
-- already hides unpublished rows — the explicit `published` keeps an admin (who can read
-- drafts) from seeing a post on one here, which the insert policy below makes impossible
-- to create anyway.
create policy post_read_published on public.post
  for select to authenticated
  using (exists (
    select 1 from public.race_date r where r.id = race_date_id and r.published
  ));

-- The boat's owner, against a published date that has not started. Refused loudly (42501).
create policy post_insert_owner on public.post
  for insert to authenticated
  with check (
    public.owns_boat(boat_id)
    and exists (
      select 1 from public.race_date r
       where r.id = race_date_id and r.published and r.starts_at > now()
    )
  );

-- Closing: the column grant limits the update to closed_at; this limits it to the owner's
-- posts. A non-owner's update matches zero rows.
create policy post_update_owner on public.post
  for update to authenticated
  using (public.owns_boat(boat_id))
  with check (public.owns_boat(boat_id));
