-- Càrrega Tri · sincronització diària de Garmin per a tots els atletes
-- Canvia CANVIA_AIXO per la mateixa paraula secreta que tens a Edge Functions › Secrets › CRON_SECRET.
-- S'executa a les 6:00 i a les 20:00 UTC (7:00 i 21:00 a l'hivern a Catalunya).
select cron.unschedule('carrega-sync-garmin') where exists (select 1 from cron.job where jobname = 'carrega-sync-garmin');
select cron.schedule('carrega-sync-garmin', '0 6,20 * * *', $$
  select net.http_post(
    url := 'https://usktsnbiliacshtecvsg.supabase.co/functions/v1/intervals-sync',
    headers := '{"Content-Type":"application/json","x-cron-secret":"CANVIA_AIXO"}'::jsonb,
    body := '{"action":"storeAll"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
