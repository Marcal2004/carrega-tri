# Càrrega Tri

App de control de càrrega de triatló.

- Web: https://marcal2004.github.io/carrega-tri/
- Dades: Supabase (taula `docs`, protegida amb inici de sessió). L'esquema és a `schema.sql`.

## Sincronització amb Garmin (via intervals.icu)

La funció `supabase/functions/intervals-sync` llegeix activitats i wellness d'intervals.icu.
Secrets necessaris a Supabase (Edge Functions › Secrets): `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `OWNER_EMAIL`.
L'app sincronitza en obrir-se i des de Jo › Configuració › Sincronitzar Garmin.
