-- M.Endurance · mode club
-- Executa-ho una sola vegada a Supabase › SQL Editor (després de schema_coach.sql).
-- Model: el club és d'un entrenador (admin). Tots els atletes del club estan vinculats a l'admin
-- (coach_links), i l'admin pot assignar cada atleta a un altre entrenador del club
-- (una fila més a coach_links). Així l'admin ho veu tot i cada entrenador només els seus.

-- 1. Taules
create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null unique references auth.users(id) on delete cascade,
  name text not null default 'Club' check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create table if not exists public.club_coaches (
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  added_at timestamptz not null default now(),
  primary key (club_id, user_id)
);
create table if not exists public.club_links (
  token text primary key,
  club_id uuid not null references public.clubs(id) on delete cascade,
  active boolean not null default true,
  uses int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.clubs enable row level security;
alter table public.club_coaches enable row level security;
alter table public.club_links enable row level security;
-- Lectura directa mínima; tota la gestió passa per les funcions de sota
drop policy if exists "clubs_read" on public.clubs;
create policy "clubs_read" on public.clubs for select using (
  owner = auth.uid() or exists (select 1 from public.club_coaches c where c.club_id = clubs.id and c.user_id = auth.uid()));
drop policy if exists "club_coaches_read" on public.club_coaches;
create policy "club_coaches_read" on public.club_coaches for select using (
  user_id = auth.uid() or exists (select 1 from public.clubs k where k.id = club_coaches.club_id and k.owner = auth.uid()));
drop policy if exists "club_links_read" on public.club_links;
create policy "club_links_read" on public.club_links for select using (
  exists (select 1 from public.clubs k where k.id = club_links.club_id and k.owner = auth.uid()));

-- 2. L'ID d'intervals.icu es manté igual a totes les files de l'atleta
create or replace function public.sync_intervals_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.coach_links set intervals_id = new.intervals_id
    where athlete_id = new.athlete_id and coach_id <> new.coach_id
      and intervals_id is distinct from new.intervals_id;
  return new;
end $$;
drop trigger if exists trg_sync_intervals_id on public.coach_links;
create trigger trg_sync_intervals_id after update of intervals_id on public.coach_links
  for each row when (old.intervals_id is distinct from new.intervals_id)
  execute function public.sync_intervals_id();

-- 3. Funcions
create or replace function public.my_club_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.clubs where owner = auth.uid()
$$;

-- Crear o reanomenar el meu club (només entrenadors)
create or replace function public.club_save(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; n text := left(trim(coalesce(p_name,'')), 60);
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  if not exists (select 1 from public.coaches where user_id = auth.uid()) then raise exception 'nocoach'; end if;
  if n = '' then raise exception 'name'; end if;
  insert into public.clubs (owner, name) values (auth.uid(), n)
    on conflict (owner) do update set name = excluded.name returning id into v;
  return v;
end $$;

-- Afegir un entrenador al club pel seu correu o usuari (ha de tenir compte)
create or replace function public.club_add_coach(p_email text) returns uuid
language plpgsql security definer set search_path = public, auth as $$
declare v_club uuid := public.my_club_id(); v_uid uuid; v_mail text := lower(trim(p_email));
begin
  if v_club is null then raise exception 'noclub'; end if;
  select id into v_uid from auth.users where lower(email) = v_mail limit 1;
  if v_uid is null then raise exception 'nouser'; end if;
  if v_uid = auth.uid() then raise exception 'self'; end if;
  insert into public.coaches (user_id) values (v_uid) on conflict do nothing;
  insert into public.club_coaches (club_id, user_id, email) values (v_club, v_uid, v_mail) on conflict do nothing;
  return v_uid;
end $$;

-- Treure un entrenador del club (perd l'accés als atletes del club)
create or replace function public.club_remove_coach(p_uid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_club uuid := public.my_club_id();
begin
  if v_club is null then raise exception 'noclub'; end if;
  delete from public.coach_links l where l.coach_id = p_uid
    and l.athlete_id in (select athlete_id from public.coach_links where coach_id = auth.uid());
  delete from public.club_coaches where club_id = v_club and user_id = p_uid;
  return 'ok';
end $$;

-- Assignar un atleta del club a un entrenador (null = només l'admin)
create or replace function public.club_assign(p_athlete uuid, p_coach uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_club uuid := public.my_club_id(); v_row public.coach_links;
begin
  if v_club is null then raise exception 'noclub'; end if;
  select * into v_row from public.coach_links where coach_id = auth.uid() and athlete_id = p_athlete;
  if not found then raise exception 'noathlete'; end if;
  delete from public.coach_links l where l.athlete_id = p_athlete
    and l.coach_id in (select user_id from public.club_coaches where club_id = v_club)
    and l.coach_id is distinct from p_coach;
  if p_coach is not null then
    if not exists (select 1 from public.club_coaches where club_id = v_club and user_id = p_coach) then raise exception 'nocoach'; end if;
    insert into public.coach_links (coach_id, athlete_id, athlete_email, intervals_id)
      values (p_coach, p_athlete, v_row.athlete_email, v_row.intervals_id)
      on conflict (coach_id, athlete_id) do update set intervals_id = excluded.intervals_id;
  end if;
  return 'ok';
end $$;

-- Link obert del club: en crea un de nou (desactiva l'anterior)
create or replace function public.club_link_new() returns text
language plpgsql security definer set search_path = public as $$
declare v_club uuid := public.my_club_id(); v_tok text;
begin
  if v_club is null then raise exception 'noclub'; end if;
  update public.club_links set active = false where club_id = v_club and active;
  v_tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.club_links (token, club_id) values (v_tok, v_club);
  return v_tok;
end $$;
create or replace function public.club_link_off() returns text
language plpgsql security definer set search_path = public as $$
begin
  update public.club_links set active = false where club_id = public.my_club_id() and active;
  return 'ok';
end $$;

-- Tot el que l'app necessita del club en una sola crida
create or replace function public.club_me() returns json
language plpgsql stable security definer set search_path = public as $$
declare v_own uuid := public.my_club_id(); v_mem uuid;
begin
  if auth.uid() is null then return null; end if;
  if v_own is not null then
    return json_build_object(
      'role','admin',
      'club',(select row_to_json(k) from (select id,name from public.clubs where id = v_own) k),
      'coaches',coalesce((select json_agg(json_build_object('uid',user_id,'email',email) order by added_at) from public.club_coaches where club_id = v_own),'[]'::json),
      'link',(select row_to_json(x) from (select token,uses,created_at from public.club_links where club_id = v_own and active order by created_at desc limit 1) x),
      'assign',coalesce((select json_agg(json_build_object('athlete',l.athlete_id,'coach',l.coach_id))
         from public.coach_links l join public.club_coaches c on c.user_id = l.coach_id and c.club_id = v_own
         where l.athlete_id in (select athlete_id from public.coach_links where coach_id = auth.uid())),'[]'::json));
  end if;
  select club_id into v_mem from public.club_coaches where user_id = auth.uid() limit 1;
  if v_mem is not null then
    return json_build_object('role','coach',
      'club',(select row_to_json(k) from (select id,name from public.clubs where id = v_mem) k));
  end if;
  return null;
end $$;

-- Nom del club per a la pantalla d'alta (també sense sessió)
create or replace function public.club_public(p_token text) returns text
language sql stable security definer set search_path = public as $$
  select k.name from public.club_links l join public.clubs k on k.id = l.club_id
  where l.token = upper(trim(p_token)) and l.active limit 1
$$;

-- Un atleta que ja té compte s'uneix amb el link
create or replace function public.redeem_club(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_tok text := upper(trim(p_token));
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select k.owner into v_owner from public.club_links l join public.clubs k on k.id = l.club_id
    where l.token = v_tok and l.active;
  if v_owner is null then raise exception 'invalid'; end if;
  if v_owner = auth.uid() then raise exception 'self'; end if;
  insert into public.coach_links (coach_id, athlete_id, athlete_email)
    values (v_owner, auth.uid(), auth.email()) on conflict do nothing;
  update public.club_links set uses = uses + 1 where token = v_tok;
  return 'ok';
end $$;

revoke all on function public.my_club_id() from public, anon;
revoke all on function public.club_save(text) from public, anon;
revoke all on function public.club_add_coach(text) from public, anon;
revoke all on function public.club_remove_coach(uuid) from public, anon;
revoke all on function public.club_assign(uuid, uuid) from public, anon;
revoke all on function public.club_link_new() from public, anon;
revoke all on function public.club_link_off() from public, anon;
revoke all on function public.club_me() from public, anon;
revoke all on function public.redeem_club(text) from public, anon;
grant execute on function public.my_club_id(), public.club_save(text), public.club_add_coach(text),
  public.club_remove_coach(uuid), public.club_assign(uuid, uuid), public.club_link_new(),
  public.club_link_off(), public.club_me(), public.redeem_club(text) to authenticated;
grant execute on function public.club_public(text) to anon, authenticated;
