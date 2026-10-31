# Càrrega Tri

App de control de càrrega de triatló.

- Web: https://marcal2004.github.io/carrega-tri/
- Dades: Supabase (taula `docs`, protegida amb inici de sessió). L'esquema és a `schema.sql`.

## Sincronització amb Garmin (via intervals.icu)

La funció `supabase/functions/intervals-sync` llegeix activitats i wellness d'intervals.icu.
Secrets necessaris a Supabase (Edge Functions › Secrets): `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `OWNER_EMAIL`.
L'app sincronitza en obrir-se i des de Jo › Configuració › Sincronitzar Garmin.

## Mode entrenador

1. Executa `schema_coach.sql` a Supabase › SQL Editor.
2. Fes-te entrenador amb l'última línia de l'script (amb el teu correu).
3. A la web: Jo › Atletes › Convidar atleta. L'atleta entra el codi a Jo › Configuració › Entrenador.
4. Garmin de l'atleta: t'ha d'afegir com a entrenador a intervals.icu; després posa el seu ID (i123…) a la seva fitxa.
