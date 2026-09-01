-- 0014 — service_role reads `answer`, for the skipper notification (story #24).
--
-- Numbered by arrival: 0013 was on disk when this story started, so this takes the next free
-- number (overlay rule since #23's collision). **Paste after 0007**, which creates the table;
-- in numeric order after 0013 is fine and is the expected path.
--
-- notifyAnswer() (src/notify/answer.ts) counts a post's un-withdrawn answers as the service
-- role — the N in "N crew answered". 0010 granted service_role select on everything else the
-- notifiers read (post, boat, race_date, person, person_contact, availability) and 0013 added
-- push_subscription; `answer` (0007) predates both and was never in the list because nothing
-- server-side read it until now. The hosted project's creation-time default may grant ALL
-- anyway (cairn: supabase-rls-column-grants — two surfaces that disagree about a value nobody
-- set); this file is what makes the grant true by declaration rather than by inheritance, and
-- it is what the pglite harness measures.
--
-- No new table, no new function, no client-role change: the skipper notification writes only
-- notification_log, which 0010 already grants.

grant select on public.answer to service_role;
