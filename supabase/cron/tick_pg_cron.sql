-- ============================================================
-- MedScan | Schedule GET /api/cron/tick every minute from Supabase
-- File: supabase/cron/tick_pg_cron.sql
-- ============================================================
-- NOT a migration. Run this once, by hand, in the Supabase SQL Editor.
--
-- Why: Vercel Hobby cron only fires once a day, so per-minute reminders need
-- pg_cron + pg_net inside Supabase. This file is the free alternative to the
-- `vercel.json` entry.
--
-- Run the two statements in PART 1 once, then PART 2 (or PART 3) once.
-- ============================================================

-- ------------------------------------------------------------
-- PART 1: enable the extensions (idempotent)
-- ------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- PART 2 (RECOMMENDED): store the URL + secret in Vault, then schedule.
-- Replace the two placeholders, then run the whole block.
-- ------------------------------------------------------------
-- select vault.create_secret('https://<project-ref>.supabase.co', 'medscan_cron_url');
-- select vault.create_secret('<CRON_SECRET>', 'medscan_cron_secret');

select cron.schedule(
  'medscan-tick',
  '* * * * *',
  $$
  select net.http_get(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'medscan_cron_url'
    ) || '/api/cron/tick',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'medscan_cron_secret'
      )
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- ------------------------------------------------------------
-- PART 3 (FALLBACK): no Vault. Inlines the values — keep this file private.
-- ------------------------------------------------------------
-- select cron.schedule(
--   'medscan-tick',
--   '* * * * *',
--   $$
--   select net.http_get(
--     url := 'https://<project-ref>.supabase.co/api/cron/tick',
--     headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb,
--     timeout_milliseconds := 55000
--   );
--   $$
-- );

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
-- Inspect the schedule:
--   select jobid, jobname, schedule, command from cron.job;
-- Recent runs + an HTTP result id:
--   select status, return_message, start_time from cron.job_run_details
--   order by start_time desc limit 10;
--   select id, status_code, content, created from net._http_response
--   order by created desc limit 10;
-- Remove it:
--   select cron.unschedule('medscan-tick');
