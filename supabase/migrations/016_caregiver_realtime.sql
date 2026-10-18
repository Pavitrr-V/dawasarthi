-- ============================================================
-- MedScan | Add caregiver_links to Realtime
-- File: supabase/migrations/015_caregiver_realtime.sql
-- ============================================================
-- The caregiver dashboard subscribes to `caregiver_links` so a revoked link
-- disappears immediately (and consent changes propagate) without waiting for the
-- 30s polling fallback. `dose_logs` is already in the publication.
--
-- Realtime only delivers rows the subscriber is allowed to SELECT; existing
-- RLS (caregiver_links_select_owner_or_invitee) already restricts delivery to
-- the owner or the assigned caregiver.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'caregiver_links'
    ) then
      alter publication supabase_realtime add table public.caregiver_links;
    end if;
  end if;
end
$$;