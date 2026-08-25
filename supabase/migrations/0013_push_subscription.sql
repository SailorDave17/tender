-- 0013 — push subscriptions, the push half of the ledger, and the bet's instrument (story #29).
--
-- **Paste after 0012**, in numeric order. It alters `suggestion` (0010) and references
-- `person` (0002), and its admin function calls `is_admin()` (0004).
--
-- NUMBERING. AC 1 asks for `0011`. That was taken by #69 before this story was picked up, and
-- 0012 by #25 the same day, so this is the next free number — the directory is the authority and
-- an AC's number is a prediction (owner decision 2026-08-23 on #23, now the third time). The
-- story's own comment of 2026-08-25 already recorded that 0011 was gone.
--
-- WHAT A SUBSCRIPTION IS, AND WHY IT IS TREATED AS A SECRET. An endpoint is a **capability URL**:
-- anyone holding it can push to that device until it is revoked, without any credential of the
-- member's. It is not an identifier that happens to be private — possession IS the authority. So
-- no client role may read anyone else's row, and the admin screen AC 6 asks for does not get a
-- widened policy; it gets a function that answers *how many* without ever returning an endpoint.
-- That is 0007's `answer_counts()` shape, and it is the only way to satisfy AC 1's self-only read
-- and AC 6's roster at once.
--
-- THE INSERT IS THE CLIENT'S, and deliberately so. AC 1 says inserts arrive through a Server
-- Action; that action uses the caller's cookie-bound client, so the `with check` below is the
-- database repeating the rule the action already applied. A service-role insert would work and
-- would move the ownership rule into TypeScript alone, where nothing enforces it twice — which is
-- the opposite of how every other table here is built.

-- ---------------------------------------------------------------------------------------------
-- push_subscription
-- ---------------------------------------------------------------------------------------------

create table public.push_subscription (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.person (id) on delete cascade,
  -- Unique across the table, not per person: one device is one subscription, and if it were
  -- somehow offered for two people the first owner keeps it rather than the row moving.
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

-- A person's own devices, for the toggle's "you have N devices" read and for the delete.
create index push_subscription_person on public.push_subscription (person_id);

alter table public.push_subscription enable row level security;

revoke all on public.push_subscription from anon, authenticated;

-- `endpoint` is readable, `p256dh` and `auth` are not, and the split is the whole point.
--
-- The two KEYS are the crypto material a sender encrypts with; nothing in the browser needs them
-- back, so no client role gets them and a column nobody may select cannot be leaked later by a
-- policy somebody widens.
--
-- The ENDPOINT has to be readable by its owner, and it took pglite to notice: turning
-- notifications off deletes `where endpoint = <the browser's own>`, and a WHERE clause needs
-- SELECT on the column it names — so without this grant the delete is refused outright and a
-- member can subscribe but never unsubscribe. It gives away nothing: the endpoint is the row
-- owner's own, their browser is holding it already, and the self-only policy means they can read
-- no other.
grant select (id, person_id, endpoint, created_at) on public.push_subscription to authenticated;
grant insert (person_id, endpoint, p256dh, auth) on public.push_subscription to authenticated;
grant delete on public.push_subscription to authenticated;
create policy push_subscription_read_self on public.push_subscription
  for select to authenticated
  using (person_id = auth.uid());

create policy push_subscription_insert_self on public.push_subscription
  for insert to authenticated
  with check (person_id = auth.uid());

create policy push_subscription_delete_self on public.push_subscription
  for delete to authenticated
  using (person_id = auth.uid());

-- The server reads every subscription to send, and deletes one the push service has retired
-- (404/410, AC 3). It writes none: a subscription exists because a browser made it.
grant select, delete on public.push_subscription to service_role;

-- ---------------------------------------------------------------------------------------------
-- suggestion.pushed_at — the push half of the same ledger row
-- ---------------------------------------------------------------------------------------------

-- AC 4 asks that a second run send zero pushes, on the same ledger. The ledger is the suggestion
-- row; this is a second column on it rather than a second table.
--
-- Why not reuse `notified_at`. That column means *the email went*, and the two channels do not
-- succeed and fail together: a send skipped at Resend's daily cap leaves `notified_at` NULL on
-- purpose so tomorrow's first run retries it (0010, story #23 AC 5). Sharing one column would
-- make that retry re-push everybody it re-emails — a duplicate notification caused by a cap that
-- has nothing to do with push, on the channel the whole bet rests on. One column per channel
-- makes each independently idempotent, which is what AC 4 actually asks for.
alter table public.suggestion add column pushed_at timestamptz;

grant update (pushed_at) on public.suggestion to service_role;

-- ---------------------------------------------------------------------------------------------
-- The bet's instrument (AC 6)
-- ---------------------------------------------------------------------------------------------

-- ADR 007's kill condition is a proportion — *fewer than half the first cohort installed two
-- weeks after invitation* — and #32 is the story that reads it. This is the query behind it, and
-- it lives in the database rather than in the admin page because the page has no way to see the
-- rows: `push_subscription` is self-only, correctly, so an admin's own client reads exactly their
-- own devices and nobody else's.
--
-- Returns a COUNT per person and never an endpoint, so a caller learns that a member has two
-- devices and nothing that would let them reach either. Definer, admin-gated by raising 42501
-- the way 0003's invite-code functions do, so a crew calling it directly is refused by Postgres
-- whatever the page believed.
create function public.push_install_status()
  returns table (person_id uuid, devices integer)
  language plpgsql stable security definer
  set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  return query
    select p.id,
           (select count(*)::integer from public.push_subscription s where s.person_id = p.id)
      from public.person p
     order by p.display_name;
end
$$;

-- `from public, anon` by name: the hosted project grants anon execute on every new function
-- directly and the local image does not, so revoking from public alone leaves anon able to call
-- it (cairn: postgrest-probing-a-live-project, §4).
revoke all on function public.push_install_status() from public, anon;
grant execute on function public.push_install_status() to authenticated;
