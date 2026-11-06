-- M.Endurance · admin total i biblioteca d'exercicis
-- Executa-ho a Supabase › SQL Editor (després de schema_coach.sql i schema_club.sql).
-- ABANS: crea el compte d'admin a Authentication › Users › Add user (veure el pas a pas)
-- i, si no fas servir l'usuari «admin», canvia el correu de l'apartat 1.

-- 0. Correcció: evita una recursió entre les regles de clubs i club_coaches
drop policy if exists "club_coaches_read" on public.club_coaches;
create policy "club_coaches_read" on public.club_coaches for select using (user_id = auth.uid());

-- 1. Qui és admin total
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.platform_admins enable row level security;
drop policy if exists "padmin_self" on public.platform_admins;
create policy "padmin_self" on public.platform_admins for select using (user_id = auth.uid());
insert into public.platform_admins (user_id)
  select id from auth.users where lower(email) = 'admin@usuaris.carregatri.app'
  on conflict do nothing;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- 2. L'admin pot llegir les dades de tothom i editar-ne la planificació
drop policy if exists "docs_admin_read" on public.docs;
create policy "docs_admin_read" on public.docs for select using (public.is_platform_admin());
drop policy if exists "docs_admin_ins" on public.docs;
create policy "docs_admin_ins" on public.docs for insert with check (coll in ('plan','dayplan','macros','races') and public.is_platform_admin());
drop policy if exists "docs_admin_upd" on public.docs;
create policy "docs_admin_upd" on public.docs for update
  using (coll in ('plan','dayplan','macros','races') and public.is_platform_admin())
  with check (coll in ('plan','dayplan','macros','races') and public.is_platform_admin());
drop policy if exists "docs_admin_del" on public.docs;
create policy "docs_admin_del" on public.docs for delete using (coll in ('plan','dayplan','macros','races') and public.is_platform_admin());

-- 3. Funcions de gestió (totes comproven que qui crida és admin)
create or replace function public.admin_overview() returns json
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  return json_build_object(
    'coaches', coalesce((select json_agg(json_build_object(
        'uid', c.user_id, 'email', u.email,
        'athletes', (select count(*) from public.coach_links l where l.coach_id = c.user_id),
        'owns', (select name from public.clubs k where k.owner = c.user_id),
        'member', (select k.name from public.club_coaches m join public.clubs k on k.id = m.club_id where m.user_id = c.user_id limit 1))
      order by u.email) from public.coaches c join auth.users u on u.id = c.user_id), '[]'::json),
    'clubs', coalesce((select json_agg(json_build_object(
        'id', k.id, 'name', k.name, 'owner', k.owner, 'owner_email', u.email,
        'coaches', coalesce((select json_agg(json_build_object('uid', m.user_id, 'email', m.email)) from public.club_coaches m where m.club_id = k.id), '[]'::json),
        'athletes', (select count(*) from public.coach_links l where l.coach_id = k.owner),
        'link', (select json_build_object('token', token, 'uses', uses) from public.club_links x where x.club_id = k.id and x.active order by created_at desc limit 1))
      order by k.name) from public.clubs k join auth.users u on u.id = k.owner), '[]'::json),
    'users', coalesce((select json_agg(json_build_object(
        'uid', u.id, 'email', u.email, 'created', u.created_at,
        'name', (select d.data->>'name' from public.docs d where d.user_id = u.id and d.coll = 'profile' and d.id = 'profile'),
        'coach', exists (select 1 from public.coaches c where c.user_id = u.id),
        'admin', exists (select 1 from public.platform_admins p where p.user_id = u.id),
        'intervals', (select l.intervals_id from public.coach_links l where l.athlete_id = u.id and l.intervals_id is not null limit 1),
        'coaches', coalesce((select json_agg(l.coach_id) from public.coach_links l where l.athlete_id = u.id), '[]'::json))
      order by u.created_at desc) from auth.users u), '[]'::json));
end $$;

-- Donar o treure el rol d'entrenador
create or replace function public.admin_set_coach(p_uid uuid, p_on boolean) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if p_on then
    insert into public.coaches (user_id) values (p_uid) on conflict do nothing;
  else
    if exists (select 1 from public.clubs where owner = p_uid) then raise exception 'ownsclub'; end if;
    delete from public.club_coaches where user_id = p_uid;
    delete from public.coach_links where coach_id = p_uid;
    delete from public.invites where coach_id = p_uid and used_by is null;
    delete from public.coaches where user_id = p_uid;
  end if;
  return 'ok';
end $$;

-- Vincular o desvincular un atleta d'un entrenador
create or replace function public.admin_link(p_coach uuid, p_athlete uuid, p_on boolean) returns text
language plpgsql security definer set search_path = public, auth as $$
declare v_iid text; v_mail text;
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if p_on then
    if not exists (select 1 from public.coaches where user_id = p_coach) then raise exception 'nocoach'; end if;
    if p_coach = p_athlete then raise exception 'self'; end if;
    select intervals_id into v_iid from public.coach_links where athlete_id = p_athlete and intervals_id is not null limit 1;
    select email into v_mail from auth.users where id = p_athlete;
    insert into public.coach_links (coach_id, athlete_id, athlete_email, intervals_id)
      values (p_coach, p_athlete, v_mail, v_iid) on conflict do nothing;
  else
    delete from public.coach_links where coach_id = p_coach and athlete_id = p_athlete;
  end if;
  return 'ok';
end $$;

-- ID d'intervals.icu d'un atleta (a totes les seves files)
create or replace function public.admin_set_intervals(p_athlete uuid, p_iid text) returns text
language plpgsql security definer set search_path = public as $$
declare v text := nullif(lower(trim(coalesce(p_iid,''))), '');
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if v is not null and v !~ '^i[0-9]+$' then raise exception 'format'; end if;
  update public.coach_links set intervals_id = v where athlete_id = p_athlete;
  return 'ok';
end $$;

-- Codi d'invitació en nom d'un entrenador
create or replace function public.admin_invite(p_coach uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v text; a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int;
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.coaches where user_id = p_coach) then raise exception 'nocoach'; end if;
  loop
    v := '';
    for i in 1..6 loop v := v || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    exit when not exists (select 1 from public.invites where code = v);
  end loop;
  insert into public.invites (code, coach_id) values (v, p_coach);
  return v;
end $$;

-- Clubs
create or replace function public.admin_club(p_club uuid, p_action text, p_name text default null) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'forbidden'; end if;
  if p_action = 'rename' then
    if coalesce(trim(p_name),'') = '' then raise exception 'name'; end if;
    update public.clubs set name = left(trim(p_name), 60) where id = p_club;
  elsif p_action = 'linkoff' then
    update public.club_links set active = false where club_id = p_club and active;
  elsif p_action = 'delete' then
    -- Treu els vincles dels entrenadors del club; els atletes es queden amb el propietari
    delete from public.coach_links l where l.coach_id in (select user_id from public.club_coaches where club_id = p_club)
      and l.athlete_id in (select athlete_id from public.coach_links where coach_id = (select owner from public.clubs where id = p_club));
    delete from public.clubs where id = p_club;
  else raise exception 'action'; end if;
  return 'ok';
end $$;

-- 4. Biblioteca d'exercicis (tothom amb compte la pot consultar)
create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users(id) on delete set null,
  name text not null check (char_length(name) between 1 and 80),
  grp text not null default 'Altres',
  equipment text,
  description text,
  youtube text,
  video_path text,
  created_at timestamptz not null default now()
);
alter table public.exercises enable row level security;
drop policy if exists "ex_read" on public.exercises;
create policy "ex_read" on public.exercises for select using (auth.uid() is not null);
drop policy if exists "ex_ins" on public.exercises;
create policy "ex_ins" on public.exercises for insert with check (
  owner = auth.uid() and (exists (select 1 from public.coaches where user_id = auth.uid()) or public.is_platform_admin()));
drop policy if exists "ex_upd" on public.exercises;
-- Els exercicis inicials (sense propietari) els pot completar qualsevol entrenador (p. ex. afegir-hi el vídeo)
create policy "ex_upd" on public.exercises for update
  using (owner = auth.uid() or public.is_platform_admin() or (owner is null and exists (select 1 from public.coaches where user_id = auth.uid())))
  with check (owner = auth.uid() or public.is_platform_admin() or (owner is null and exists (select 1 from public.coaches where user_id = auth.uid())));
drop policy if exists "ex_del" on public.exercises;
create policy "ex_del" on public.exercises for delete using (owner = auth.uid() or public.is_platform_admin());

-- Vídeos propis: carpeta pública de Storage (fins a 50 MB per vídeo)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('exercise-videos', 'exercise-videos', true, 52428800, array['video/mp4','video/quicktime','video/webm'])
  on conflict (id) do nothing;
drop policy if exists "exv_ins" on storage.objects;
create policy "exv_ins" on storage.objects for insert to authenticated with check (
  bucket_id = 'exercise-videos' and (storage.foldername(name))[1] = auth.uid()::text
  and (exists (select 1 from public.coaches where user_id = auth.uid()) or public.is_platform_admin()));
drop policy if exists "exv_del" on storage.objects;
create policy "exv_del" on storage.objects for delete to authenticated using (
  bucket_id = 'exercise-videos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_platform_admin()));

-- Exercicis inicials (sense vídeo: cada entrenador hi pot afegir el seu)
insert into public.exercises (name, grp, equipment, description)
select * from (values
  ('Esquat amb barra','Cames','Barra','Barra sobre els trapezis, peus a l''amplada de les espatlles. Baixa amb el pit amunt i els genolls en la direcció de les puntes fins a paral·lel o una mica més avall, i puja empenyent el terra.'),
  ('Esquat goblet','Cames','Manuella o kettlebell','Pes agafat davant del pit. Baixa entre els genolls mantenint l''esquena recta i els talons a terra. Bo per aprendre el patró d''esquat.'),
  ('Pes mort romanès','Cames','Barra o manuelles','Genolls lleugerament flexionats, porta el maluc enrere amb l''esquena neutra fins notar tensió als isquiotibials i torna a pujar tancant el maluc.'),
  ('Pes mort convencional','Cames','Barra','Barra tocant les tíbies, esquena neutra i braços estirats. Empeny el terra amb les cames i estén maluc i genolls alhora fins quedar dret.'),
  ('Gambada','Cames','Pes corporal o manuelles','Un pas llarg endavant i baixa fins que els dos genolls quedin a uns 90°. Tronc vertical i genoll davanter alineat amb el peu.'),
  ('Esquat búlgar','Cames','Banc i manuelles','Peu del darrere sobre un banc. Baixa amb la cama del davant fins que el genoll del darrere s''acosti a terra. Molt útil per treballar cada cama per separat.'),
  ('Step-up','Cames','Caixa o banc','Puja a la caixa empenyent amb la cama de dalt, sense impulsar-te amb la de baix, i baixa controlant.'),
  ('Elevació de bessons','Cames','Esglaó i pes opcional','Talons fora d''un esglaó. Puja de puntetes al màxim i baixa lent fins a l''estirament. Es pot fer amb el genoll estirat o flexionat.'),
  ('Hip thrust','Glutis','Banc i barra','Esquena recolzada al banc i barra sobre el maluc. Puja el maluc fins alinear-lo amb el tronc i aguanta un segon apretant els glutis.'),
  ('Pont de glutis','Glutis','Pes corporal','Estirat panxa amunt, genolls flexionats. Eleva el maluc apretant els glutis sense arquejar la zona lumbar.'),
  ('Monster walk amb goma','Glutis','Goma elàstica','Goma als turmells o sobre els genolls, mig esquat. Camina endavant i de costat mantenint la tensió a la goma.'),
  ('Clamshell','Glutis','Goma elàstica','Estirat de costat amb genolls flexionats. Obre el genoll de dalt sense rotar el maluc enrere i torna lentament.'),
  ('Planxa frontal','Tronc','Pes corporal','Recolzat sobre avantbraços i puntes. Cos en línia recta, abdomen i glutis actius, sense enfonsar la zona lumbar.'),
  ('Planxa lateral','Tronc','Pes corporal','Recolzat sobre un avantbraç i el costat del peu. Maluc amunt i cos en línia recta.'),
  ('Dead bug','Tronc','Pes corporal','Panxa amunt, braços cap al sostre i genolls a 90°. Estira el braç i la cama contraris sense que la zona lumbar se separi del terra.'),
  ('Bird dog','Tronc','Pes corporal','A quatre grapes, estira el braç i la cama contraris fins a l''horitzontal mantenint l''esquena quieta.'),
  ('Pallof press','Tronc','Goma o politja','De costat a l''ancoratge, empeny les mans endavant des del pit i aguanta sense deixar que el tronc giri.'),
  ('Flexions','Tren superior','Pes corporal','Mans una mica més obertes que les espatlles i cos en línia recta. Baixa el pit a prop del terra i empeny.'),
  ('Rem amb manuella','Tren superior','Manuella i banc','Una mà i un genoll al banc, esquena plana. Porta la manuella cap al maluc acostant l''escàpula a la columna.'),
  ('Dominades','Tren superior','Barra fixa','Penjat amb els braços estirats, puja fins que la barbeta passi la barra sense balancejar. Es pot ajudar amb goma.'),
  ('Rem invertit','Tren superior','Barra baixa o anelles','Cos en línia recta sota la barra. Porta el pit cap a la barra i baixa controlant.'),
  ('Press militar','Tren superior','Barra o manuelles','Dret i amb el tronc ferm, empeny el pes des de les espatlles fins a sobre del cap sense arquejar l''esquena.'),
  ('Face pull','Tren superior','Politja o goma','Tira de la corda cap a la cara amb els colzes alts, obrint les mans al final. Bo per a l''espatlla de nedadors.'),
  ('Salt a la caixa','Pliometria','Caixa','Salt amb els dos peus a sobre de la caixa amb impuls de braços. Aterra suau amb els genolls flexionats i baixa caminant.'),
  ('Skipping','Pliometria','Pes corporal','Elevació de genolls ràpida amb contacte curt a terra sobre l''avantpeu i braços coordinats.'),
  ('Salts a peus junts','Pliometria','Pes corporal','Salts seguits sobre l''avantpeu amb poc temps de contacte i turmells rígids.'),
  ('Nòrdic d''isquiotibials','Prevenció','Company o suport per als peus','De genolls amb els talons fixats, deixa''t caure endavant tan lentament com puguis amb el cos recte. Ajuda a prevenir lesions d''isquiotibials.'),
  ('Copenhagen','Prevenció','Banc','Planxa lateral amb la cama de dalt sobre un banc. Treballa els adductors; comença amb el genoll recolzat.'),
  ('Excèntric de bessons','Prevenció','Esglaó','Puja amb les dues cames i baixa lentament només amb una des de les puntetes. Útil per al tendó d''Aquil·les.'),
  ('Rotació externa d''espatlla','Prevenció','Goma elàstica','Colze enganxat al costat a 90°. Gira l''avantbraç cap enfora contra la goma i torna lentament.')
) as v(name, grp, equipment, description)
where not exists (select 1 from public.exercises e where e.owner is null and e.name = v.name);

grant execute on function public.is_platform_admin(), public.admin_overview(), public.admin_set_coach(uuid, boolean),
  public.admin_link(uuid, uuid, boolean), public.admin_set_intervals(uuid, text), public.admin_invite(uuid),
  public.admin_club(uuid, text, text) to authenticated;
revoke execute on function public.admin_overview(), public.admin_set_coach(uuid, boolean), public.admin_link(uuid, uuid, boolean),
  public.admin_set_intervals(uuid, text), public.admin_invite(uuid), public.admin_club(uuid, text, text) from anon, public;
