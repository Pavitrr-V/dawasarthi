alter table public.caregiver_links
  drop constraint caregiver_links_patient_id_caregiver_user_id_key;

create unique index if not exists caregiver_links_live_uniq
  on public.caregiver_links (patient_id, caregiver_user_id)
  where caregiver_user_id is not null and status in ('pending', 'active');