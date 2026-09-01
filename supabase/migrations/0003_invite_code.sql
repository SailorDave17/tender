-- 0003 — rotate the invite code in one admin action (story #16).
--
-- Numbered per the filing plan and landing after 0004–0008, so the sequence on disk is now
-- complete but the paste order is not the numeric order. **Paste after 0004**: both functions
-- below call is_admin() (0004) and read club (0001). Both are `language plpgsql`, whose body is
-- resolved at CALL time and not at CREATE (a `language sql` body would have refused to be
-- created ahead of 0004 — measured on 0004 itself against 0002), so pasting this file before
-- 0004 would succeed and leave two functions that raise 42883 on first use. The pglite harness
-- applies files in name order, 0003 before 0004, and that is why it still works there: nothing
-- calls either function until every file is in. The tests call both, so an unsatisfied
-- reference reddens rather than waiting (cairn: a-dropped-table-does-not-drop-its-readers).
--
-- This is the definer path 0001's comment reserved for admin writes: no client role holds
-- update on club, and the only way the code changes is through rotate_invite_code(), which
-- decides who may call it from person.is_admin via is_admin() — never from anything the
-- caller sends. Parameter-free, so there is nothing for a column name to shadow
-- (cairn: postgres-sql-function-parameter-shadowing-2026-08-21); a later admin function that
-- takes person_id or match_id must qualify fn.param, as accept_answer() (0008) does.
--
-- The code: 8 characters from a 32-letter alphabet (0–9 and A–Z without I, L, O and U, so a
-- code read off a class handout cannot be mis-typed between 0/O or 1/I/L), 40 bits, drawn from
-- gen_random_uuid()'s bytes — the one CSPRNG Postgres exposes without pgcrypto, and pglite has
-- no pgcrypto. random() is not used: it is a PRNG, and a guessable code is a leaked code.
--
-- current_invite_code() exists so the admin screen can SHOW the code without the client
-- holding a select on the column (0002 withheld it from every client role, and stays that
-- way): the code reaches exactly the browser of a signed-in admin, which is who hands it out.
--
-- Execute is revoked from PUBLIC and from anon by name. PUBLIC alone is not enough on the
-- live project: Supabase's default privileges grant execute on every new function to anon
-- DIRECTLY (measured 2026-08-22 — anon ran answer_counts() and reached accept_answer()'s body
-- over PostgREST, both of which 0007/0008 revoke from public only), and a revoke from public
-- does not touch a grant made to a role by name. Schema-wide that is 0015's (story #48); here the two
-- functions that return the invite code are closed to anon by this file whatever the platform
-- granted. They would refuse anon anyway (is_admin() is false with no JWT), so this is a second
-- wall, not the first.

create function public.rotate_invite_code() returns text
  language plpgsql security definer
  set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 32 letters: byte % 32 is uniform
  bytes    bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  code     text := '';
  v_club   uuid;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  for i in 0..7 loop
    code := code || substr(alphabet, get_byte(bytes, i) % 32 + 1, 1);
  end loop;
  -- The one club row, by id. `into strict` raises if there is not exactly one; and the WHERE is
  -- load-bearing, not style: Supabase loads safeupdate on PostgREST's connection, which refuses
  -- an UPDATE with no WHERE clause (21000 "UPDATE requires a WHERE clause") for every caller,
  -- the admin included — measured 2026-08-22 on the local stack, where a whole-table update
  -- that pglite accepts failed on the first GET probe. A body that runs only through PostgREST
  -- is a body that must satisfy PostgREST's connection settings.
  select c.id into strict v_club from public.club c;
  update public.club set invite_code = code where id = v_club;
  return code;
end
$$;

create function public.current_invite_code() returns text
  language plpgsql stable security definer
  set search_path = ''
as $$
declare
  code text;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  select c.invite_code into strict code from public.club c;
  return code;
end
$$;

revoke all on function public.rotate_invite_code() from public, anon;
revoke all on function public.current_invite_code() from public, anon;
grant execute on function public.rotate_invite_code() to authenticated;
grant execute on function public.current_invite_code() to authenticated;
