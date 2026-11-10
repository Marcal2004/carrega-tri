# M.Endurance (repo `carrega-tri`) · context per a Claude

App web (PWA) d'entrenament de triatló i running de @marcal.endurance. Atletes, entrenadors, clubs i un admin total.
Interfície en **català**. Contingut de màrqueting (Instagram) en castellà.

## Desplegament
- **Web:** https://mendurance.app (GitHub Pages des de la branca `main` d'aquest repo, fitxer `CNAME`).
  L'adreça antiga `marcal2004.github.io/carrega-tri` hi redirigeix. Domini a Porkbun (DNS: 4 registres A de GitHub + CNAME `www`).
- **Backend:** Supabase, projecte `usktsnbiliacshtecvsg`. La clau `SB_KEY` de l'index és la publicable (pública per disseny).
- Cada `git push` a `main` publica la web en 1–2 minuts. No hi ha build: tot és `index.html`.
- **El SQL i les Edge Functions NO es despleguen sols.** L'usuari els enganxa a mà al panell de Supabase
  (SQL Editor / Edge Functions › Code › Deploy). Dona-li els fitxers i el pas a pas.

## Fitxers
- `index.html` (~2.800 línies): tota l'app. HTML + CSS + un sol `<script>` dins d'un IIFE `(() => { "use strict"; … })()`.
- `sw.js` (service worker, push), `manifest.webmanifest`, icones.
- `schema.sql` (taula `docs`), `schema_coach.sql`, `schema_club.sql`, `schema_admin.sql`, `schema_push.sql`, `schema_sync.sql`, `schema_races.sql`.
- `supabase/functions/`:
  - `intervals-sync/` → desplegada amb el nom **intervals-sync** (sincronia intervals.icu, enviament al rellotge, avisos d'activitat).
  - `push/` → desplegada amb el nom **clever-api** (no es pot reanomenar; al client `PUSH_FN="clever-api"`). Recordatoris i proves de notificació.
  - `signup/` → desplegada amb el nom **bright-service**. Alta amb codi d'invitació o amb link de club.

## Arquitectura del client (index.html)
- Estat global `st`. `render()` pinta segons `st.mode` (login, consent, welcome, loading, db) i el rol:
  admin (`st.isAdmin` → `renderAdmin`, pestanyes `st.aview`), entrenador (`st.isCoach` → `renderCoach`, `st.cview`), atleta (`st.view`: avui/setmana/grafics/pla, i `st.plaTab` dins Jo).
- Clics: un sol dispatcher amb `data-act="..."` i `e.target.closest("[data-act]")` → `switch(a)`.
- Fulls inferiors: `openSheet(html)`, `closeSheet()`, `sheetHead(títol, sub)`, estat temporal a `sheetState`.
- Dades: `write(kind,id,data)` desa a `docs` (si `st.viewUid` hi ha, només col·leccions de `COACH_EDIT`: plan, dayplan, macros, races).
  Si és `dayplan` d'avui o futur → `autoPush` → `pushToWatch` (intervals-sync action `push`).
- Col·leccions (`COLLS`): sessions, daily, weights, macros, plan, tests, dayplan, races; a més profile, tpl (plantilles), anote (notes de l'entrenador).
- Pla del dia: `dayplan[date] = {items:[{disc,title,min,warm,main,cool,notes,detail,watch,iev,status,orig,adj}], note}` (màx. 4 items).
  `watch` = passos en format intervals.icu (`- 10m 70% LTHR`, `4x`, ritme `- 1m 6:00/km Pace`, línia en blanc abans i després de les repeticions).
- Recuperació v2: VFC 50 % (70+20z) / FC repòs 25 % (75−5·Δ) / qüestionari 25 % (total/20); alarmes limiten a 45.
  Colors `SC_COL`: verd ≥67, groc 34–66, vermell. Finestra `recPrompt` després del qüestionari: mantenir / més curt (−30 %) / suau.
- Tests estàndard (`TEST_W`, escalfaments `TW_RUN`, `TW_BIKE`, `TW_SWIM`), càlcul automàtic de zones (`testCalc`).
- Entrenador: Panell, Planificar (tocar un dia → `sheetQuickDay`: plantilles, biblioteca `WLIB`, entreno nou, descans), Entrenos (sessions / exercicis), Anàlisi, Jo (atletes, club, plantilles).
- Club: `st.club` = resultat de `rpc club_me` (`role` admin|coach, `coaches`, `link`, `assign`). Link obert `?club=TOKEN` (12 hex).
- Admin total: `rpc admin_overview` → `st.adm`; accions amb `admin_*`.
- Exercicis: taula `exercises`, vídeos al bucket públic `exercise-videos` (carpeta = uid, màx. 50 MB) o enllaç YouTube (embed youtube-nocookie).

## Base de dades (Supabase)
- `docs(user_id, coll, id, data jsonb)` amb RLS: cadascú les seves; l'entrenador llegeix les dels seus atletes i edita només planificació.
- `coaches`, `invites` (codis 6 caràcters, 14 dies, un sol ús), `coach_links(coach_id, athlete_id, athlete_email, intervals_id)`.
  Un trigger manté igual `intervals_id` a totes les files d'un atleta.
- Club: `clubs(owner)`, `club_coaches`, `club_links(token, active, uses)`. Els atletes del club sempre estan vinculats al propietari; assignar = fila extra a `coach_links`.
  Funcions: `club_save`, `club_add_coach`, `club_remove_coach`, `club_assign`, `club_link_new/off`, `club_me`, `club_public` (anon), `redeem_club`.
- Admin: `platform_admins`, `is_platform_admin()`, `admin_overview`, `admin_set_coach`, `admin_link`, `admin_set_intervals`, `admin_invite`, `admin_club`.
- Push: `push_subs`, `push_config`. Cron (pg_cron): `carrega-recordatori` cada hora → clever-api `{action:"cron"}`; `carrega-sync-garmin` minut 25 → intervals-sync `storeAll` (capçalera `x-cron-secret`).
- Secrets de les funcions (només a Supabase, mai al repo): `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `OWNER_EMAIL`, `CRON_SECRET`, claus VAPID.
- Rellotge: tot passa per intervals.icu amb la clau de l'entrenador principal. L'atleta ha de posar-lo com a **Coach** a intervals.icu (no com a follower) i el seu ID `i123…` va a `coach_links.intervals_id`.

## Regles de treball (importants)
- **El repo és públic:** cap secret, contrasenya, clau service_role ni dada personal. El CRON_SECRET i similars només a Supabase.
- No demanis ni acceptis la clau `service_role` ni la contrasenya de la base de dades. Les claus les posa l'usuari a Supabase.
- Abans de pujar canvis: `git pull --rebase`. Autor: `-c user.name="Marcal2004" -c user.email="alumnes.euses@gmail.com"`.
- Després d'editar l'script, comprova la sintaxi: extreure el `<script>` inline i `node --check`.
- Proves visuals: Playwright amb un mock de `window.supabase` (servint `index.html` per `page.route` i injectant `window.__ev=(c)=>eval(c)` abans de `setTimeout(boot, 0);` per accedir a l'IIFE).
- SQL nou: idempotent (`create … if not exists`, `drop policy if exists`, `create or replace`), funcions `security definer` amb `set search_path`, i compte amb recursions de RLS entre taules.
- Marca: M.Endurance. Daurat `#C8A96A`, negre `#0E0E0F`, ivori `#F4F1EA`/`#EDE8DF`. Logo/emblema (nedador-ciclista-corredor) a `LOGO_BANNER`.
- Les explicacions a l'usuari, en català i pas a pas (on clicar exactament); no té perfil tècnic.
