-- M.Endurance · catàleg de curses de la pàgina inicial
-- Executa-ho una vegada a Supabase › SQL Editor. Es pot tornar a executar sense perill.

create table if not exists public.race_catalog (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  date       date not null,
  city       text,
  region     text,
  kind       text not null check (kind in ('tri','marato','mitja','10k','5k')),
  dist       text,                       -- només triatló: Sprint, Olímpic, 70.3, Ironman…
  url        text,
  confirmed  boolean not null default true,  -- false = data per confirmar
  status     text not null default 'pending' check (status in ('pending','approved','hidden')),
  source     text,                       -- d'on ha sortit (seed, auto, manual)
  created_at timestamptz not null default now(),
  unique (name, date)
);
create index if not exists race_catalog_date_idx on public.race_catalog (date);

alter table public.race_catalog enable row level security;

-- Qualsevol visitant de la web pot veure les curses publicades
drop policy if exists "race_public_read" on public.race_catalog;
create policy "race_public_read" on public.race_catalog for select using (status = 'approved');

-- L'admin (tu) ho pot veure i gestionar tot
drop policy if exists "race_admin_all" on public.race_catalog;
create policy "race_admin_all" on public.race_catalog for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

grant select on public.race_catalog to anon, authenticated;
grant insert, update, delete on public.race_catalog to authenticated;

-- Primeres curses (queden com a PENDENTS: revisa-les a l'app › Curses abans de publicar-les)
insert into public.race_catalog (name, date, city, region, kind, dist, confirmed, source) values
  ('Medio Maratón de Sevilla',                 '2026-11-29', 'Sevilla',            'Andalucía',      'mitja',  null,      true,  'seed'),
  ('Maratón Internacional Elche-Alicante',     '2026-11-29', 'Elx',                'C. Valenciana',  'marato', null,      false, 'seed'),
  ('Maratón Valencia Trinidad Alfonso',        '2026-12-06', 'València',           'C. Valenciana',  'marato', null,      true,  'seed'),
  ('10K Valencia Ibercaja',                    '2027-01-10', 'València',           'C. Valenciana',  '10k',    null,      true,  'seed'),
  ('Mitja Marató de Sitges',                   '2027-01-10', 'Sitges',             'Catalunya',      'mitja',  null,      true,  'seed'),
  ('La Mitja de Granollers',                   '2027-01-24', 'Granollers',         'Catalunya',      'mitja',  null,      true,  'seed'),
  ('Mitja Marató Internacional de Santa Pola', '2027-01-24', 'Santa Pola',         'C. Valenciana',  'mitja',  null,      true,  'seed'),
  ('Maratón de Murcia Costa Cálida',           '2027-02-07', 'Murcia',             'Región de Murcia','marato', null,     false, 'seed'),
  ('Mitja Marató de Barcelona',                '2027-02-14', 'Barcelona',          'Catalunya',      'mitja',  null,      true,  'seed'),
  ('Zurich Maratón de Sevilla',                '2027-02-21', 'Sevilla',            'Andalucía',      'marato', null,      true,  'seed'),
  ('Medio Maratón de Málaga',                  '2027-03-07', 'Málaga',             'Andalucía',      'mitja',  null,      false, 'seed'),
  ('Zurich Marató de Barcelona',               '2027-03-14', 'Barcelona',          'Catalunya',      'marato', null,      true,  'seed'),
  ('Medio Maratón de Madrid',                  '2027-04-04', 'Madrid',             'Madrid',         'mitja',  null,      false, 'seed'),
  ('IRONMAN 70.3 Valencia',                    '2027-04-18', 'València',           'C. Valenciana',  'tri',    '70.3',    true,  'seed'),
  ('Maratón de Madrid',                        '2027-04-25', 'Madrid',             'Madrid',         'marato', null,      true,  'seed'),
  ('Marató de Castelló',                       '2027-04-25', 'Castelló de la Plana','C. Valenciana', 'marato', null,      false, 'seed'),
  ('IRONMAN 70.3 Alcúdia-Mallorca',            '2027-05-08', 'Alcúdia',            'Illes Balears',  'tri',    '70.3',    true,  'seed'),
  ('IRONMAN Lanzarote',                        '2027-05-15', 'Puerto del Carmen',  'Canarias',       'tri',    'Ironman', true,  'seed'),
  ('IRONMAN Vitoria-Gasteiz',                  '2027-07-11', 'Vitoria-Gasteiz',    'País Vasco',     'tri',    'Ironman', true,  'seed'),
  ('IRONMAN 70.3 Vitoria-Gasteiz',             '2027-07-11', 'Vitoria-Gasteiz',    'País Vasco',     'tri',    '70.3',    true,  'seed'),
  ('IRONMAN Calella-Barcelona',                '2027-10-03', 'Calella',            'Catalunya',      'tri',    'Ironman', false, 'seed'),
  ('Ironcat Triatló L''Ampolla',               '2027-10-09', 'L''Ampolla',         'Catalunya',      'tri',    'Ironman', false, 'seed'),
  ('Palma Marathon Mallorca',                  '2027-10-17', 'Palma',              'Illes Balears',  'marato', null,      false, 'seed'),
  ('Medio Maratón Valencia Trinidad Alfonso',  '2027-10-24', 'València',           'C. Valenciana',  'mitja',  null,      false, 'seed')
on conflict (name, date) do nothing;
