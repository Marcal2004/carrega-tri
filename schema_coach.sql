-- Càrrega Tri · mode entrenador
-- Executa-ho una sola vegada a Supabase › SQL Editor (després de schema.sql).

-- 1. Qui és entrenador
create table if not exists public.coaches (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.coaches enable row level security;
drop policy if exists "coaches_self" on public.coaches;
create policy "coaches_self" on public.coaches for select using (user_id = auth.uid());

-- 2. Codis d'invitació
create table if not exists public.invites (
  code text primary key,
  coach_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);
alter table public.invites enable row level security;
drop policy if exists "invites_coach" on public.invites;
create policy "invites_coach" on public.invites for all
  using (coach_id = auth.uid())
  with check (coach_id = auth.uid() and exists (select 1 from public.coaches c where c.user_id = auth.uid()));

-- 3. Vincles entrenador ↔ atleta
create table if not exists public.coach_links (
  coach_id uuid not null references auth.users(id) on delete cascade,
  athlete_id uuid not null references auth.users(id) on delete cascade,
  athlete_email text,
  intervals_id text check (intervals_id is null or intervals_id ~ '^i[0-9]+$'),
  created_at timestamptz not null default now(),
  primary key (coach_id, athlete_id)
);
alter table public.coach_links enable row level security;
drop policy if exists "links_read" on public.coach_links;
create policy "links_read" on public.coach_links for select using (coach_id = auth.uid() or athlete_id = auth.uid());
drop policy if exists "links_coach_update" on public.coach_links;
create policy "links_coach_update" on public.coach_links for update using (coach_id = auth.uid()) with check (coach_id = auth.uid());
drop policy if exists "links_delete" on public.coach_links;
create policy "links_delete" on public.coach_links for delete using (coach_id = auth.uid() or athlete_id = auth.uid());

-- 4. L'entrenador pot llegir totes les dades dels seus atletes
--    i editar-ne només la planificació (plan, dayplan, macros, races)
drop policy if exists "docs_coach_read" on public.docs;
create policy "docs_coach_read" on public.docs for select using (
  exists (select 1 from public.coach_links l where l.coach_id = auth.uid() and l.athlete_id = docs.user_id));
drop policy if exists "docs_coach_insert" on public.docs;
create policy "docs_coach_insert" on public.docs for insert with check (
  coll in ('plan','dayplan','macros','races') and
  exists (select 1 from public.coach_links l where l.coach_id = auth.uid() and l.athlete_id = docs.user_id));
drop policy if exists "docs_coach_update" on public.docs;
create policy "docs_coach_update" on public.docs for update
  using (coll in ('plan','dayplan','macros','races') and
    exists (select 1 from public.coach_links l where l.coach_id = auth.uid() and l.athlete_id = docs.user_id))
  with check (coll in ('plan','dayplan','macros','races') and
    exists (select 1 from public.coach_links l where l.coach_id = auth.uid() and l.athlete_id = docs.user_id));
drop policy if exists "docs_coach_delete" on public.docs;
create policy "docs_coach_delete" on public.docs for delete using (
  coll in ('plan','dayplan','macros','races') and
  exists (select 1 from public.coach_links l where l.coach_id = auth.uid() and l.athlete_id = docs.user_id));

-- 5. L'atleta canvia un codi per vincular-se
create or replace function public.redeem_invite(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v_coach uuid; v_code text := upper(trim(p_code));
begin
  if auth.uid() is null then raise exception 'auth'; end if;
  select coach_id into v_coach from public.invites
    where code = v_code and used_by is null and created_at > now() - interval '14 days' for update;
  if v_coach is null then raise exception 'invalid'; end if;
  if v_coach = auth.uid() then raise exception 'self'; end if;
  insert into public.coach_links (coach_id, athlete_id, athlete_email)
    values (v_coach, auth.uid(), auth.email()) on conflict do nothing;
  update public.invites set used_by = auth.uid(), used_at = now() where code = v_code;
  return 'ok';
end $$;
revoke all on function public.redeem_invite(text) from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;

-- 6. Fes-te entrenador (canvia el correu pel teu i executa-ho):
-- insert into public.coaches (user_id) select id from auth.users where email = 'EL_TEU_CORREU';
