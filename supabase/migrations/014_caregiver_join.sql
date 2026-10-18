-- ============================================================
-- MedScan | Caregiver linking (join rate limiting)
-- File: supabase/migrations/014_caregiver_join.sql
-- ============================================================
-- Run this AFTER 013_service_role_grants.sql (in the SQL Editor).
--
-- The caregiver claim flow lives in a server route that uses the
-- service-role client (it must read an invite the caregiver cannot yet
-- see through RLS). Postgres still runs the caregiver_links_protect
-- trigger for that client, but that trigger returns early when
-- auth.uid() is null (which is the case for a service-role request), so
-- the claim can set caregiver_user_id while leaving status='pending'.
--
-- This file only adds the storage needed to rate-limit join attempts
-- (5 per hour per signed-in user). It holds no personal data.
-- ============================================================

begin;

create table if not exists public.caregiver_join_attempts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    created_at timestamptz not null default now()
);

-- Fast "how many attempts in the last hour for this user" lookups.
create index if not exists caregiver_join_attempts_user_time_idx
    on public.caregiver_join_attempts (user_id, created_at desc);

alter table public.caregiver_join_attempts enable row level security;

-- No policies on purpose: only the service role (which bypasses RLS) may
-- read or write this table. Nothing here is ever exposed to a client.
revoke all on table public.caregiver_join_attempts from public, anon, authenticated;
grant all on table public.caregiver_join_attempts to service_role;

commit;

-- ============================================================
-- END OF MIGRATION
