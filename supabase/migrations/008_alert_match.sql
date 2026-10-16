-- ============================================================
-- MedScan | NSQ alert matcher (batch-alert pipeline)
-- File: supabase/migrations/008_alert_match.sql
-- ============================================================
-- Run this AFTER 006_online_checks.sql (in the SQL Editor).
--
-- 006_online_checks.sql created a 4-arg match_nsq_alerts(p_product_name,
-- p_batch_no, p_threshold, p_limit) that matched and classified in SQL.
-- The batch-alert pipeline (lib/alerts.ts) wants a simpler contract: match by
-- NAME only, return the normalised columns, and let TypeScript decide
-- name_and_batch vs name_only (so it is unit-testable).
--
-- So this file DROPS the old overload and creates a 2-arg one
-- match_nsq_alerts(p_name text, p_threshold real default 0.6). It is idempotent.
-- ============================================================

-- Remove the previous (4-arg) overload so there is exactly one matcher.
drop function if exists public.match_nsq_alerts(text, text, real, integer);

-- Fuzzy-match a medicine NAME against nsq_alerts using pg_trgm similarity on
-- product_name_norm. Returns the normalised columns so the caller can decide
-- whether the batch also matches. security definer + empty search_path;
-- similarity() is schema-qualified because pg_trgm lives in "extensions".
create or replace function public.match_nsq_alerts(
    p_name text,
    p_threshold real default 0.6
)
returns table (
    id uuid,
    product_name text,
    product_name_norm text,
    batch_no text,
    batch_no_norm text,
    manufacturer text,
    alert_type text,
    alert_date date,
    source_url text,
    fetched_at timestamptz,
    raw jsonb,
    similarity real
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        a.id,
        a.product_name,
        a.product_name_norm,
        a.batch_no,
        a.batch_no_norm,
        a.manufacturer,
        a.alert_type,
        a.alert_date,
        a.source_url,
        a.fetched_at,
        a.raw,
        extensions.similarity(
            a.product_name_norm,
            public.normalize_product_name(p_name)
        ) as similarity
    from public.nsq_alerts a
    where public.normalize_product_name(p_name) <> ''
      and extensions.similarity(
              a.product_name_norm,
              public.normalize_product_name(p_name)
          ) >= coalesce(p_threshold, 0.6)
    order by
        extensions.similarity(
            a.product_name_norm,
            public.normalize_product_name(p_name)
        ) desc,
        a.alert_date desc
    limit 10;
$$;

-- ------------------------------------------------------------
-- Privilege hardening
-- ------------------------------------------------------------
revoke all on function public.match_nsq_alerts(text, real) from public, anon;

grant execute on function public.match_nsq_alerts(text, real)
    to authenticated, service_role;
