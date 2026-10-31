-- Càrrega Tri · recordatori del qüestionari (notificacions)
-- Executa-ho a Supabase › SQL Editor. Abans, canvia CANVIA_AIXO per la mateixa
-- paraula secreta que posaràs a Edge Functions › Secrets com a CRON_SECRET.

create table if not exists public.push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  sub jsonb not null,
  hour int not null default 8 check (hour between 0 and 23),
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists "push_own" on public.push_subs;
create policy "push_own" on public.push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Claus de les notificacions: només la funció (service role) hi té accés
create table if not exists public.push_config (
  id int primary key default 1,
  public_key text not null,
  private_key text not null
);
alter table public.push_config enable row level security;

create extension if not exists pg_net;
create extension if not exists pg_cron;

select cron.unschedule('carrega-recordatori') where exists (select 1 from cron.job where jobname = 'carrega-recordatori');
select cron.schedule('carrega-recordatori', '0 * * * *', $$
  select net.http_post(
    url := 'https://usktsnbiliacshtecvsg.supabase.co/functions/v1/push',
    headers := '{"Content-Type":"application/json","x-cron-secret":"CANVIA_AIXO"}'::jsonb,
    body := '{"action":"cron"}'::jsonb
  );
$$);
