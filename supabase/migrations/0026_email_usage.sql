-- 0026 — what the admin screen may read of the email log (story #39).
--
-- **Apply after 0010**, which creates `notification_log`, and after 0004, which creates
-- `is_admin()`; in numeric order after 0025 is the expected path. It creates no table, so the
-- rule that 0015 and 0016 go last does not reach it.
--
-- WHY A DEFINER AT ALL. ADR 007's promised consequence is that "the admin view shows the day's
-- send count against 100", and 0010 put `notification_log` out of every client role's reach on
-- purpose: `revoke all … from anon, authenticated`, RLS enabled, no policy. That is still the
-- right shape — the log names who was emailed at what address, and no member should read it —
-- so the screen gets a COUNT and never a row. This is 0003's arrangement for the invite code in
-- a second dress: the column stays withheld, a definer answers the one question the admin needs,
-- and `is_admin()` decides who may ask. The page's own `notFound()` already refuses a non-admin;
-- this is the second wall, and it is the one that holds when a future screen forgets the first
-- (`src/admin/load.ts`'s header: a column that is not already club-visible needs the database's
-- refusal in the same change).
--
-- Reading it as `service_role` from the page instead would have been the wrong repair, for the
-- reason 0004's header gives: it makes the page the sole author of its own authorization.
--
-- WHY THE KINDS ARE AN ARGUMENT. Which `notification_log.kind` values are an ATTEMPT on the
-- provider — as against a skip, a suppression, or a row with no address to send to — is decided
-- in one place, `src/notify/kinds.ts`'s EMAIL_ATTEMPT_KINDS, and every sender's cap read agrees
-- with it (#37's fan-out found three stores disagreeing when each kept its own list). A copy of
-- that list in SQL would be a fourth, and the one nothing holds to the others — the defect class
-- `test/migrations-hygiene.test.ts` exists for. So the caller sends the list and this file counts.
-- The kinds are not a permission: every row it can see is already the admin's to count, and a
-- caller passing a different list gets a different count of their own log, nothing more.
--
-- WHY THE BOUNDARIES ARE ARGUMENTS TOO. `now()` here would be a second clock. /admin decides its
-- whole page at one instant (`const now = new Date()`), and a day boundary read from the database
-- could fall on the other side of UTC midnight from the one the page labelled — so the caller
-- sends both instants and this file compares. It also makes the day rule testable where it is
-- written: `emailDayStart`/`emailMonthStart` are pure functions with `now` injected.
--
-- WHY TWO COUNTS IN ONE CALL. Resend Free is 100/day AND 3,000/month (ADR 007), and both must be
-- decided at the same instant for the same reason the page has one clock. One round trip, one
-- scan, two `filter`s.
--
-- GRANTS, AND WHICH HALF OF THE REVOKE ACTUALLY DOES ANYTHING. The line below revokes execute
-- from PUBLIC and from `anon`. Only the PUBLIC half is load-bearing for a function created this
-- late, and the header of an earlier file would have told you the opposite.
--
-- *Measured 2026-09-20 by mutation*: dropping `, anon` from the line reddens **0** tests;
-- dropping the whole line reddens **2** — this file's own anon deny and `test/anon-grants.test.ts`'s
-- schema-wide sweep. The reason is 0015: `alter default privileges in schema public revoke all on
-- functions from anon` took away the platform's by-name grant for every function created after it,
-- so there is no by-name grant here to revoke. What remains is Postgres's own built-in EXECUTE to
-- PUBLIC, which 0015 explicitly CANNOT reach (its header measures six spellings that all fail),
-- and which the `public` half takes away.
--
-- 0003's header — "a revoke from public does not touch a grant made to a role by name" — is still
-- true and no longer the situation: it was written for 0003, which ran before 0015 existed.
--
-- The `, anon` stays anyway. Every file carries it, it costs nothing, and 0015's default is one
-- `alter` away from moving — but this header must not claim the anon refusal as its own, which is
-- the exact wording trap `#68` recorded for tables and this extends to functions.
-- `anon` would be refused in the body regardless: `is_admin()` is false with no JWT.

create function public.email_usage(
  p_kinds       text[],
  p_day_start   timestamptz,
  p_month_start timestamptz
) returns table (day_count integer, month_count integer)
  language plpgsql stable security definer
  set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  -- `fn.p_*` is not needed here — the parameters are prefixed so nothing on notification_log can
  -- shadow them (cairn: postgres-sql-function-parameter-shadowing-2026-08-21) — but the OUT
  -- column names CAN be shadowed by the count expressions, which is why the aliases below are
  -- assigned positionally through `return query` rather than by name.
  return query
    select
      count(*) filter (where n.sent_at >= p_day_start)::integer,
      count(*) filter (where n.sent_at >= p_month_start)::integer
    from public.notification_log n
    where n.channel = 'email'
      and n.kind = any (p_kinds)
      -- The narrower of the two windows still has to be scanned for the wider count, so the
      -- floor is the month's. 0010's (channel, sent_at) index serves it.
      and n.sent_at >= least(p_day_start, p_month_start);
end
$$;

revoke all on function public.email_usage(text[], timestamptz, timestamptz) from public, anon;
grant execute on function public.email_usage(text[], timestamptz, timestamptz) to authenticated;
