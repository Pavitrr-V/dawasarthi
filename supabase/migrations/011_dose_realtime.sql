-- ============================================================
-- MedScan | Live dose_logs for the home timeline
-- File: supabase/migrations/011_dose_realtime.sql
-- ============================================================
-- The /home timeline subscribes to dose_logs so a dose marked taken / skipped /
-- snoozed (here, in another tab, or from a push notification) updates every
-- open screen without a reload.
--
-- Realtime only delivers rows the subscriber is allowed to SELECT, and the
-- existing policies already scope dose_logs to the patient's owner:
--   dose_logs_select_authorized  (public.can_view_patient)
--   dose_logs_select_owner       (010_schedule_policies.sql)
--
-- Guarded so re-running is safe and so it does not fail on a bare Postgres
-- project where the supabase_realtime publication is absent.
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'dose_logs'
        ) then
            alter publication supabase_realtime add table public.dose_logs;
        end if;
    end if;
end
$$;
