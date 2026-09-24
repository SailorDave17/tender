-- 0035 — invite codes lose the digits 0 and 1, and every character is drawn uniformly (story #243).
--
-- **Apply after 0003**, whose rotate_invite_code() this file replaces, and after 0004, whose
-- is_admin() the body calls. In numeric order after 0034 is the expected path. It creates no table
-- and no new function, so the rule that 0015 and 0016 go last does not reach it.
--
-- ---------------------------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------------------------
--
-- An invite code written on a board at the club is hard to read when it holds a 0, because 0 and O
-- look alike. 0003's alphabet already leaves out I, L, O and U, so it has no look-alike PAIR in it —
-- but that helps nobody who does not know the alphabet: a member looking at "0" on a whiteboard
-- cannot tell whether to type zero or O, and the same goes for 1 against I and L. Owner decision
-- 2026-09-24: drop the digits 0 and 1 as well. The alphabet is now 30 characters,
-- `23456789ABCDEFGHJKMNPQRSTVWXYZ`, and eight of them carry log2(30) × 8 ≈ 39.3 bits.
--
-- 0003's header claims 40 bits, and that was never true. It drew character i from byte i of
-- gen_random_uuid(), for i in 0..7. A version-4 UUID's byte 6 is always 0x40–0x4F (its high nibble
-- is the version), so `byte % 32` for the 7th character was always 0–15: one of 0–9 or A–F, and a 0
-- one time in 16. That is 39 bits, and a 0 in about one code in four. Simulated in Node against
-- 0003's algorithm (200,000 draws); for Postgres it is reasoned from gen_random_uuid() being v4 by
-- its docs. 0003's header is left as written; this file is where the correction lives.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT CHANGES
-- ---------------------------------------------------------------------------------------------
--
--   rotate_invite_code()   REPLACED. Same signature, same admin check, same single-row update.
--                          `create or replace` keeps the function's owner and its grants, so
--                          0003's `revoke all … from public, anon` and `grant execute … to
--                          authenticated` still stand, as 0029 relied on for 0027's function;
--                          test/invite-code.test.ts's anon and 42501 cases run against this body.
--                          What changes is the draw:
--
--     the bytes      Still gen_random_uuid()'s, because it is the one CSPRNG Postgres exposes
--                    without pgcrypto, and pglite has no pgcrypto. Bytes 6 and 8 are skipped:
--                    byte 6 carries the version nibble and byte 8 the two variant bits, so they
--                    hold 4 and 6 random bits where every other byte holds 8. That leaves 14
--                    bytes a UUID; when they run out before eight characters are accepted, a
--                    fresh UUID is drawn.
--
--     the reduction  30 does not divide 256, so `byte % 30` would give the first 16 characters
--                    9 chances in 256 each and the other 14 only 8. A byte of 240 or more
--                    (240 = 8 × 30) is discarded instead, and every accepted byte maps to a
--                    character with probability exactly 8 in 240. On average about one byte in
--                    sixteen is discarded, so one UUID almost always suffices.
--
--   current_invite_code()  unchanged.
--
-- The code already handed out keeps working: this file changes what the NEXT rotation mints, not
-- the stored value, and rotating the live code is the admin's (out of scope for #243). A stored
-- code from 0003 may still hold a 0 or a 1 until then, and it still matches, because the gate
-- compares whatever the row holds. The gate also folds case since #243 (src/auth/join.ts,
-- codesMatch), so `abcd2345` copied off a board matches `ABCD2345`.

create or replace function public.rotate_invite_code() returns text
  language plpgsql security definer
  set search_path = ''
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 30 characters: no 0, 1, I, L, O or U
  bytes    bytea;
  b        integer;
  code     text := '';
  v_club   uuid;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  while length(code) < 8 loop
    bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    for i in 0..15 loop
      continue when i in (6, 8);  -- the version and variant bytes: not wholly random
      b := get_byte(bytes, i);
      continue when b >= 240;     -- 240 = 8 × 30; above it, byte % 30 favours the first 16
      code := code || substr(alphabet, b % 30 + 1, 1);
      exit when length(code) = 8;
    end loop;
  end loop;
  -- The one club row, by id, as 0003 does it: `into strict` raises unless there is exactly one,
  -- and the WHERE is load-bearing because Supabase loads safeupdate on PostgREST's connection.
  select c.id into strict v_club from public.club c;
  update public.club set invite_code = code where id = v_club;
  return code;
end
$$;
