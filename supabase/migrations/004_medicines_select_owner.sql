create policy medicines_select_owner
  on public.medicines
  for select
  to authenticated
  using (
    exists (
      select 1 from public.patients p
      where p.id = medicines.patient_id
        and p.owner_user_id = (select auth.uid())
    )
  );