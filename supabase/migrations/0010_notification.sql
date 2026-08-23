-- 0010 — the persisted rung, the suggestion ledger and the notification log (story #23).
--
-- Numbered 0010 rather than the filing plan's 0009, which #64 consumed (owner decision
-- 2026-08-23; #69 and #68 moved to 0011 and 0012 in the same action). **Paste after 0009**, in
-- numeric order: this file alters post (0006) and references person (0002).
--
--   post.current_rung   the rung the post is OPEN to, persisted and monotone. Until now the
--                       rung was computed on every board read from suggest() over the crew
--                       available that day (src/board/post-view.ts) — ADR 004's lazy fallback
--                       — and could move in either direction between two reads, which is fine
--                       for a colour and wrong for a notification: a rung told "we need you"
--                       must not be un-told when a better crew marks the day an hour later.
--                       The trigger below refuses any decrease; the board shows
--                       max(stored, computed) so the clock half still relaxes lazily until
--                       #25/#26 persist the step-down on a schedule.
--   suggestion          the ledger: (post, person) proposed at a rung, and when they were
--                       notified. The primary key is the pair, so a crew is suggested for a
--                       post once however many times the post is re-evaluated, and
--                       notified_at NULL is the queue — a send that failed stays NULL and the
--                       next run retries it.
--   notification_log    every send attempted, skipped or failed, by kind and channel, with
--                       the provider's id or the error. The day's email count against
--                       Resend's 100/day (ADR 007) is read from here.
--
-- All three are written ONLY by the service role — the server action computes suggest() and
-- writes as service_role — so no client role holds insert or update on any of them:
-- `revoke all` from anon and authenticated, then column grants for what the board reads
-- (post.current_rung) and nothing else. The grants to service_role are explicit because the
-- current Supabase Postgres image grants it nothing on a new table (Dxtm only, measured
-- 2026-08-22 on #17) while the hosted project grants ALL by default — two surfaces that
-- disagree about a value nobody set, so the file that creates the table says what the server
-- needs (cairn: supabase-rls-column-grants-2026-08-06, the #17 extension). The read grants on
-- older tables at the bottom are the same rule applied to what notifyRung() reads.
--
-- RLS is enabled on both new tables with NO policy: a client role with no grant and no policy
-- is refused twice over, and service_role bypasses RLS by its nature.

-- ---------------------------------------------------------------------------------------------
-- post.current_rung
-- ---------------------------------------------------------------------------------------------

alter table public.post
  add column current_rung smallint not null default 1 check (current_rung in (1, 2, 3));

grant select (current_rung) on public.post to authenticated;
-- No client update grant: 0006 grants update (closed_at) alone, and that stands.

-- Refuse a decrease. Invoker is fine (no table is read); execute is revoked from the client
-- roles anyway, since a trigger fires without its caller holding execute on the function and
-- nothing else should call it. A decrease raises 23514 (check_violation), the same family the
-- column's own check raises, so a caller reads it as "the value is not allowed".
create function public.post_rung_monotone() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.current_rung < old.current_rung then
    raise exception 'post.current_rung may not decrease (% -> %)', old.current_rung, new.current_rung
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function public.post_rung_monotone() from public, anon, authenticated;

create trigger post_rung_monotone
  before update of current_rung on public.post
  for each row execute function public.post_rung_monotone();

-- ---------------------------------------------------------------------------------------------
-- suggestion
-- ---------------------------------------------------------------------------------------------

create table public.suggestion (
  post_id     uuid not null references public.post (id) on delete cascade,
  person_id   uuid not null references public.person (id) on delete cascade,
  rung        smallint not null check (rung in (1, 2, 3)),
  notified_at timestamptz,
  created_at  timestamptz not null default now(),
  primary key (post_id, person_id)
);

alter table public.suggestion enable row level security;

revoke all on public.suggestion from anon, authenticated;
grant select, insert on public.suggestion to service_role;
grant update (notified_at) on public.suggestion to service_role;

-- ---------------------------------------------------------------------------------------------
-- notification_log
-- ---------------------------------------------------------------------------------------------

-- kind is free text within a length, not an enum: every later notification story adds kinds
-- (answer_suppressed, match_skipped_cap, …) and a check constraint rewritten per story is the
-- class of copy that drifts. The kinds this story writes are rung_email and
-- rung_email_skipped_cap (src/notify/rung.ts).
create table public.notification_log (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (length(kind) between 1 and 40),
  channel     text not null check (channel in ('email', 'push')),
  person_id   uuid references public.person (id) on delete set null,
  to_email    text,
  post_id     uuid references public.post (id) on delete set null,
  sent_at     timestamptz not null default now(),
  provider_id text,
  error       text
);

-- person_id and post_id are `on delete set null` rather than cascade: the row is a record of a
-- send that happened and a count the cap reads today; a deleted person's rows stay, anonymised
-- (charter §Data), which is the deletion story's rule applied here from the start.

-- The cap count: email rows for a day.
create index notification_log_channel_sent_at on public.notification_log (channel, sent_at);

alter table public.notification_log enable row level security;

revoke all on public.notification_log from anon, authenticated;
grant select, insert on public.notification_log to service_role;

-- ---------------------------------------------------------------------------------------------
-- What notifyRung() reads and writes as service_role on older tables. Idempotent where the
-- hosted project already grants ALL; load-bearing on the local image, where the invite gate's
-- own service-role reads needed hand grants on #17 before the app worked.
-- ---------------------------------------------------------------------------------------------

grant select on public.post, public.boat, public.race_date, public.person, public.person_contact,
  public.availability to service_role;
grant update (current_rung) on public.post to service_role;
