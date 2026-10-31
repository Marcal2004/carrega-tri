-- Càrrega Tri · esquema de la base de dades (Supabase)
-- Una sola taula: cada document de l'app (sessions, pla, tests...) és una fila.
create table if not exists public.docs (
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  coll       text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, coll, id)
);

alter table public.docs enable row level security;

-- Cada usuari només pot veure i modificar les seves pròpies dades.
drop policy if exists "docs_own" on public.docs;
create policy "docs_own" on public.docs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
