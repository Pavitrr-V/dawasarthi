-- ============================================================
-- MedScan | LLM medicine-info cache + per-user rate limit
-- File: supabase/migrations/005_info_cache.sql
-- ============================================================
-- NOTE ON NUMBERING: 005_catalog_search.sql and 006_online_checks.sql
-- already exist, so this file reuses the 005 prefix as requested. It has no
-- dependency on either, so applying it in any order is safe.
--
-- Creates:
--   1. info_cache      - global cache of LLM medicine info, keyed by a
--                        normalized composition string (sorted, lowercase).
--   2. api_rate_limits - per-user, per-route fixed-window counters.
--   3. bump_rate_limit - atomic increment used by POST /api/medicine-info.
--
-- Both tables are SERVER-ONLY: RLS is enabled with NO client policies and all
-- privileges are revoked from anon/authenticated. Only the service role
-- (SUPABASE_SERVICE_ROLE_KEY, server-side) may read or write them.
-- ============================================================

-- ------------------------------------------------------------
-- 1. info_cache
-- ------------------------------------------------------------
create table if not exists public.info_cache (
    composition_key text primary key,
    payload jsonb not null,
    source text not null default 'llm',
    model text,
    created_at timestamptz not null default now(),
    refreshed_at timestamptz not null default now()
);

alter table public.info_cache enable row level security;

revoke all on public.info_cache from anon, authenticated;
grant all on public.info_cache to service_role;

-- ------------------------------------------------------------
-- 2. api_rate_limits
-- ------------------------------------------------------------
-- One row per (user, route, fixed window). The window_start is the start of
-- the current window, computed by bump_rate_limit.
create table if not exists public.api_rate_limits (
    user_id uuid not null references public.users(id) on delete cascade,
    route text not null,
    window_start timestamptz not null,
    count integer not null default 0 check (count >= 0),
    primary key (user_id, route, window_start)
);

alter table public.api_rate_limits enable row level security;

revoke all on public.api_rate_limits from anon, authenticated;
grant all on public.api_rate_limits to service_role;

-- ------------------------------------------------------------
-- 3. bump_rate_limit
-- ------------------------------------------------------------
-- Atomically counts one call for this user/route inside the current fixed
-- window and returns the number of requests REMAINING, or -1 when the limit
-- is exceeded. Runs as the definer so the service role does not need any
-- extra table privileges.
create or replace function public.bump_rate_limit(
    p_user_id uuid,
    p_route text,
    p_limit integer,
    p_window_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_window timestamptz;
    v_count integer;
begin
    if p_limit is null or p_limit <= 0 or p_window_seconds is null or p_window_seconds <= 0 then
        raise exception 'bump_rate_limit: limit and window must be positive';
    end if;

    -- Start of the current fixed window (UTC).
    v_window := to_timestamp(
        floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
    );

    insert into public.api_rate_limits (user_id, route, window_start, count)
    values (p_user_id, p_route, v_window, 1)
    on conflict (user_id, route, window_start)
    do update set count = public.api_rate_limits.count + 1
    returning count into v_count;

    if v_count > p_limit then
        return -1;
    end if;

    return p_limit - v_count;
end;
$$;

revoke all on function public.bump_rate_limit(uuid, text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.bump_rate_limit(uuid, text, integer, integer)
    to service_role;

-- ------------------------------------------------------------
-- 4. Housekeeping helper (optional)
-- ------------------------------------------------------------
-- Delete rate-limit windows older than one day. Safe to call from a cron.
create or replace function public.prune_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_deleted integer;
begin
    delete from public.api_rate_limits
    where window_start < now() - interval '1 day';

    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

revoke all on function public.prune_rate_limits() from public, anon, authenticated;
grant execute on function public.prune_rate_limits() to service_role;

-- ============================================================
-- END OF MIGRATION
-- ============================================================
