-- 0028 — the club's two colours, set by the admin with the contrast rule enforced at save
-- (story #41).
--
-- **Apply after 0004**, which creates `is_admin()`, and after 0001, which creates `club`; in
-- numeric order after 0027 is the expected path. It creates no table, so the rule that 0015 and
-- 0016 go last does not reach it. Both functions are `language plpgsql`, whose body is resolved
-- at CALL time, so the file applies whatever order it lands in and the tests are what would
-- redden on an unsatisfied reference (0003's header has the measurement).
--
-- WHY THE RULE IS IN SQL AT ALL. The charter says "club theming is two hex values with contrast
-- >= 3.0 enforced at save", and until this story that rule lived in an untested .jsx outside
-- tsconfig, checked by nothing a request passes through. 0001's constraint refuses a value that
-- is not a colour; nothing refused a PAIR that cannot be read. `/admin/theme` disables Save below
-- 3.0, and that is the screen's courtesy, not the enforcement: a direct POST to the Server Action
-- with a 1.5:1 pair reaches this function, and this function is what says no.
--
-- `contrast_ratio()` is WCAG's relative-luminance formula, spelled a second time here beside
-- `src/brand/contrast.ts`. Two spellings of one rule, each proven where it is written and held
-- equal on the same pairs by `test/club-theme.test.ts` — the arrangement #37 made for
-- `on_race_day()` and `localDate`. It is `immutable` (a pure function of its arguments) and
-- deliberately NOT `strict`: a strict function answers NULL for a NULL argument, and a NULL ratio
-- compared `< 3.0` is NULL, which plpgsql's `if` reads as false — the pass-through #42 measured
-- on `<>` against a null party. So a NULL colour raises `'colour'` like any other non-colour.
--
-- `set_club_theme(disc, mark)` is the definer path 0001's comment reserved for admin writes,
-- 0003's arrangement with two parameters: no client role holds update on club, and the only way
-- the pair changes is through this function, which decides who may call it from person.is_admin
-- via is_admin() — never from anything the caller sends. The parameters are QUALIFIED
-- (`set_club_theme.disc`) as accept_answer() (0008) does, so no column named `disc` added later
-- can shadow them (cairn: postgres-sql-function-parameter-shadowing-2026-08-21). The WHERE is
-- load-bearing: PostgREST's connection loads safeupdate, which refuses an UPDATE with no WHERE
-- for every caller (0003 measured it).
--
-- ORDER OF REFUSALS: not an admin (42501) first, so a non-admin learns nothing about the rule;
-- then not a colour (22023 'colour'); then the pair (23514 'contrast'). The Server Action maps
-- the message, so the message IS the contract: 'contrast' and 'colour' exactly.
--
-- GRANTS. Execute on both is revoked from PUBLIC and from anon by name — the PUBLIC half is the
-- load-bearing one for a function created after 0015 (0026's header has the mutation), and the
-- anon half stays because every file carries it. `set_club_theme` is granted to authenticated,
-- who reach the body and are refused there unless admin. `contrast_ratio` is closed to every
-- client role, and that takes a revoke from `authenticated` BY NAME: the platform's default
-- privileges grant `authenticated` execute on every new function (0015 took that default away
-- for anon only), so "granted to nobody" is not the state a bare `create function` leaves it in
-- — *measured* on the harness, which reproduces the default: without the third name,
-- `authenticated` ran it. 0022's `members_among` is the precedent. The definer calls it as its
-- owner, the screen computes the ratio in TypeScript, and a client has no call to make. Read
-- `test/anon-grants.test.ts`'s sweep as the proof that neither is callable by anon.

create function public.contrast_ratio(a text, b text) returns double precision
  language plpgsql immutable
  set search_path = ''
as $$
declare
  hexes text[] := array[a, b];
  lum   double precision[] := array[0, 0];
  coef  double precision[] := array[0.2126, 0.7152, 0.0722];
  v     double precision;
begin
  for i in 1..2 loop
    if hexes[i] is null or hexes[i] !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'colour' using errcode = '22023',
        detail = coalesce(hexes[i], 'null') || ' is not a #RRGGBB colour';
    end if;
    for c in 1..3 loop
      -- RR at 2, GG at 4, BB at 6; 'x' || hex is the bit-string input form, then to an integer.
      v := (('x' || substr(hexes[i], 2 * c, 2))::bit(8)::int)::double precision / 255.0;
      -- sRGB to linear, WCAG 2.x's own constants — the same line as src/brand/contrast.ts.
      v := case when v <= 0.03928 then v / 12.92 else power((v + 0.055) / 1.055, 2.4) end;
      lum[i] := lum[i] + coef[c] * v;
    end loop;
  end loop;
  return (greatest(lum[1], lum[2]) + 0.05) / (least(lum[1], lum[2]) + 0.05);
end
$$;

create function public.set_club_theme(disc text, mark text) returns void
  language plpgsql security definer
  set search_path = ''
as $$
declare
  v_ratio double precision;
  v_club  uuid;
begin
  if not public.is_admin() then
    raise exception 'not an admin' using errcode = '42501';
  end if;
  -- Raises 'colour' on anything that is not #RRGGBB, NULL included.
  v_ratio := public.contrast_ratio(set_club_theme.disc, set_club_theme.mark);
  -- `is null` spelled out even though contrast_ratio cannot return it: a later edit that makes
  -- it strict would otherwise turn this line into a pass-through (0027's `<>` lesson).
  if v_ratio is null or v_ratio < 3.0 then
    raise exception 'contrast' using errcode = '23514',
      detail = format('%s on %s reads %s, below the 3.0 minimum', set_club_theme.disc, set_club_theme.mark, round(v_ratio::numeric, 2));
  end if;
  select c.id into strict v_club from public.club c;
  update public.club
     set brand_disc = set_club_theme.disc,
         brand_mark = set_club_theme.mark
   where id = v_club;
end
$$;

revoke all on function public.contrast_ratio(text, text) from public, anon, authenticated;
revoke all on function public.set_club_theme(text, text) from public, anon;
grant execute on function public.set_club_theme(text, text) to authenticated;
