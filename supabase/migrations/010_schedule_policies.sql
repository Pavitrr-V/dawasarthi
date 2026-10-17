create policy schedules_select_owner
  on public.schedules for select to authenticated
  using (exists (
    select 1 from public.patients p
    where p.id = schedules.patient_id
      and p.owner_user_id = (select auth.uid())
  ));

create policy dose_logs_select_owner
  on public.dose_logs for select to authenticated
  using (exists (
    select 1 from public.patients p
    where p.id = dose_logs.patient_id
      and p.owner_user_id = (select auth.uid())
  ));