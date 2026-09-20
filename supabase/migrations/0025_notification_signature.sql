-- 0025 — notification_log.signature: what an error report is "the same error" BY (story #43).
--
-- **Apply after 0010**, which creates the table; in numeric order after 0024 is the expected
-- path. It creates no table and no function, so the rule that 0015 and 0016 go last does not
-- reach it: a column added to an existing table is covered by that table's grants and nothing
-- else, and 0010 already took every one of them away from `anon` and `authenticated`.
--
-- Apply it BEFORE promoting the `develop` that carries #43. Against a project without the column
-- the reporter's dedupe read errors; that read is best-effort by design (src/notify/error.ts), so
-- the consequence is not a 500 but something quieter and worse — the in-process window becomes
-- the ONLY dedupe, one hour per warm instance, and nothing says so.
--
-- WHY A COLUMN RATHER THAN A READ OF `error`. The hour-long window in AC 2 is keyed on the error's
-- NAME and the ROUTE it threw on — `TypeError /post/[id]` — while `notification_log.error` already
-- means something else on every row in the table: the reason the PROVIDER refused the send. An
-- error report whose own email is refused needs both values at once, so they cannot share a
-- column, and a `like` prefix match over free text is not a key.
--
-- WHY IT IS NULLABLE AND UNCONSTRAINED. Every other sender writes NULL here — the value is
-- meaningless for a rung email, which is deduped by `suggestion.notified_at`, and for the five
-- senders after it. The column carries a value for exactly the two `error` kinds (0.5 rows a
-- week if the app is healthy), so a NOT NULL default would be a fiction on ten thousand rows to
-- suit two.
--
-- GRANTS: NONE NEW, ON PURPOSE. 0010's grants are table-level — `grant select, insert on
-- public.notification_log to service_role` — and a table-level grant covers a column added later.
-- So the service role writes and reads it, no client role can do either (0010 revokes all from
-- anon and authenticated and enables RLS with no policy), and this file adds nothing. Same
-- reasoning as 0019's `tick_run.sweep_at`, and `test/notification.test.ts` holds all three.

alter table public.notification_log
  add column signature text;

-- The reporter's one read: the most recent row for a signature. Partial, because the column is
-- null on every row that is not an error report, and those are the overwhelming majority — an
-- index over them would be almost entirely dead weight on the table's hot insert path.
create index notification_log_signature_sent_at
  on public.notification_log (signature, sent_at desc)
  where signature is not null;
