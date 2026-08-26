-- 0001 — the club row: one tenant, two hex values (charter: "club theming is two hex values
-- with contrast >= 3.0 enforced at save"). The contrast rule is enforced in the admin console;
-- the database only refuses values that are not colours.

create table public.club (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  brand_disc  text not null check (brand_disc ~ '^#[0-9A-Fa-f]{6}$'),
  brand_mark  text not null check (brand_mark ~ '^#[0-9A-Fa-f]{6}$'),
  invite_code text not null,
  created_at  timestamptz not null default now()
);

alter table public.club enable row level security;

-- Every signed-in person may read the club (its name and theme are on every screen).
-- Nobody writes through PostgREST: the admin console goes through a definer function in a
-- later migration. No insert/update/delete policy exists on purpose.
create policy club_read_authenticated on public.club
  for select to authenticated using (true);

grant select on public.club to authenticated;
