-- 0018 — service_role reads `match`, for the match-formed emails (story #33).
--
-- Numbered by arrival: 0017 was on disk when this story started. **Paste after 0008**, which
-- creates the table; in numeric order after 0017 is fine and is the expected path.
--
-- notifyMatch() (src/notify/match.ts) reads the match row — who the skipper and the crew are —
-- as the service role, to email both parties the moment accept_answer() succeeds. 0008 granted
-- match only to authenticated (select); nothing server-side read it until now. The hosted
-- project's creation-time default may grant ALL anyway (cairn: supabase-rls-column-grants — two
-- surfaces that disagree about a value nobody set); this file is what makes the grant true by
-- declaration rather than by inheritance, and it is what the pglite harness measures.
--
-- No new table, no new function, no client-role change: the match emails write only
-- notification_log, which 0010 already grants.

grant select on public.match to service_role;
