-- 0020 — a message on a match: the two parties talk in Tender (story #35).
--
-- Numbered by arrival, not by the filing plan: the plan said 0012, which #130 consumed for
-- `tick_run` (0012_tick_run.sql), and the directory now runs to 0019. The story takes the next
-- free number, which is the overlay's standing rule after #23 shipped as 0010 against a filed
-- 0009. The issue body carries the renumber note. **Apply order: after 0019**, in numeric
-- order, and 0008 must already be applied — `message` references `match`, and the party
-- predicate below reads it.
--
--   message   one per thing said, on a match (not a post): the author, the body, when. A row
--             is never updated by a client and never hard-deleted by one — `removed_at` is the
--             moderation stamp the charter asked for (remove a message, suspend a person), and
--             the moderation story owns who may set it. Nothing sets it here.
--
-- WHY match_id AND NOT post_id. A match is what makes two people counterparties, and the whole
-- access rule below is "the two parties to this match". `match.post_id` is unique, so the two
-- are one-to-one today and either would address the same rows — but the thread belongs to the
-- relationship, not to the need that created it, and a policy phrased in matches needs no join
-- to say who may read. The page is /post/[id]/thread (owner decision 2026-09-17) because that
-- is where a match is shown; the URL is a view onto this table, not its identity.
--
-- THE 2,000-CHARACTER CAP IS HERE AS WELL AS IN THE SERVER ACTION, on purpose. The action is
-- the place a person gets a civil refusal; this is the place the rule is true. A Server Action
-- is reachable by a direct POST from anyone who can send one (Next 16's own security guide says
-- render-time gating is not a boundary), so a cap enforced only there is a cap on the form and
-- not on the table.
--
-- No trigger, no definer function, no new RPC: every write is an ordinary insert by the author
-- through their own cookie-bound client, and the policies below are the entire access model.
-- That is deliberate — 0008 needed `accept_answer()` because it wrote two tables atomically and
-- authenticated held no insert on `match`; nothing here is atomic across tables.

create table public.message (
  id         uuid primary key default gen_random_uuid(),
  match_id   uuid not null references public.match (id) on delete cascade,
  author_id  uuid not null references public.person (id) on delete cascade,
  body       text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- Set by the moderation story; null means the message stands. Readers filter on it rather
  -- than the row disappearing, so a removed message can be shown as removed if that is wanted.
  removed_at timestamptz
);

-- The thread reads in created_at order for one match, which is exactly this index.
create index message_match_created_idx on public.message (match_id, created_at);

alter table public.message enable row level security;

-- Privileges before policies, and revoke before grant: a table-level revoke also revokes
-- matching column grants, so the two must be in this order in this file (cairn:
-- supabase-rls-column-grants). Supabase's schema default privileges hand anon, authenticated
-- and service_role broad grants that no migration mentions — 0015 narrowed the schema-wide
-- default for anon, and this file states the rest by declaration rather than inheritance.
revoke all on public.message from anon, authenticated;

-- Every column is granted for select: the thread names all of them, and a column withheld from
-- the select grant is refused wherever a statement NAMES it — including a WHERE or an ORDER BY,
-- which is how #29's `push_subscription` delete was refused while its insert stayed green. The
-- error names the table and not the column, so this is not a diagnosis anyone enjoys twice.
grant select (id, match_id, author_id, body, created_at, removed_at) on public.message to authenticated;
-- Insert names only what an author supplies. id, created_at and removed_at are the database's:
-- withholding them means a crafted insert cannot backdate a message or pre-stamp it removed.
grant insert (match_id, author_id, body) on public.message to authenticated;
-- No update and no delete to any client role. Editing and removal are the moderation story's,
-- and they will arrive as a policy on a stamp rather than as a grant to overwrite a body.

-- ---------------------------------------------------------------------------------------------
-- Who may read: the two parties to the match, and nobody else.
--
-- The subquery runs AS THE CALLER and so inherits `match`'s own read policy (0008:
-- match_read_with_post, readable wherever the post is). That inheritance is the reason the
-- predicate names both parties explicitly rather than leaning on the join: a clause whose work
-- is already done by the inner table's policy is dead, and its test is vacuous — measured on
-- this repo at #19, 0 red against a predicted 2 (cairn: supabase-rls-column-grants, the policy
-- subquery section). Here the inner policy admits every signed-in person who can see the post,
-- so `skipper_id = auth.uid() or crew_id = auth.uid()` is doing real work and a fixture exists
-- that reddens each half of it: a third signed-in person who can read the post and the match,
-- and must still get zero rows from this table.
create policy message_read_parties on public.message
  for select to authenticated
  using (
    exists (
      select 1 from public.match m
      where m.id = message.match_id
        and (m.skipper_id = auth.uid() or m.crew_id = auth.uid())
    )
  );

-- Who may write: a party, as themselves. Two independent conditions, and both are load-bearing.
--
--   author_id = auth.uid()   a party may not put words in the other's mouth. Without this, the
--                            party check below would still pass for a forged author_id.
--   the party predicate      a stranger may not write into someone else's thread, even honestly
--                            attributed to themselves.
--
-- A third signed-in person fails the second; a party forging the first fails the first; each
-- has its own fixture in the pglite test beside this file.
create policy message_write_own on public.message
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.match m
      where m.id = message.match_id
        and (m.skipper_id = auth.uid() or m.crew_id = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------------------------
-- service_role: what notifyMessage() reads, and nothing more.
--
-- Stated explicitly because the two surfaces disagree about what a new table grants by default:
-- *measured* on the local Supabase image a fresh `create table` gives service_role `Dxtm` only —
-- no DML at all — while the hosted project's creation-time default has been observed as ALL
-- (#48). A dispatcher that relies on the inherited grant therefore works on one and 500s on the
-- other, which is how /api/join's read of club.invite_code failed locally. The pglite harness
-- creates service_role with bypassrls as Supabase's has, so a missing grant here reddens there.
--
-- Select only: the dispatcher reads the message it is notifying about and the thread's history
-- to decide the window; it writes notification_log (0010 grants that) and nothing in this table.
grant select on public.message to service_role;
