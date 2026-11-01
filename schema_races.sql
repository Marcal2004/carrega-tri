-- Càrrega Tri · l'entrenador també pot editar les competicions dels atletes
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
