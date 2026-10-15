   create policy patients_select_owner
     on public.patients
     for select
     to authenticated
     using (owner_user_id = (select auth.uid()));