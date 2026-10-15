-- ============================================================
-- MedScan | Fuzzy medicine catalog search
-- File: supabase/migrations/005_catalog_search.sql
-- ============================================================
-- medicine_catalog has no barcode column, so a scanned barcode can
-- only be matched to the catalog by product name. This function does
-- a pg_trgm similarity search (>= p_threshold) ordered by similarity.
--
-- The pg_trgm extension is created in the "extensions" schema by
-- 001_init.sql, so similarity() is schema-qualified below.
-- ============================================================

create or replace function public.search_medicine_catalog(
    p_query text,
    p_threshold real default 0.5,
    p_limit integer default 5
)
returns table (
    id uuid,
    name text,
    composition text[],
    manufacturer text,
    uses text,
    side_effects text,
    similarity real
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        c.id,
        c.name,
        c.composition,
        c.manufacturer,
        c.uses,
        c.side_effects,
        extensions.similarity(c.name, p_query) as similarity
    from public.medicine_catalog c
    where extensions.similarity(c.name, p_query) >= p_threshold
    order by extensions.similarity(c.name, p_query) desc, c.name asc
    limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

revoke all on function public.search_medicine_catalog(text, real, integer)
    from public, anon;
grant execute on function public.search_medicine_catalog(text, real, integer)
    to authenticated, service_role;
