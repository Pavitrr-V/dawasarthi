-- ============================================================
-- MedScan | Online-check realtime + NSQ alert matching
-- File: supabase/migrations/006_online_checks.sql
-- ============================================================
-- The /medicine/[id] trust card shows an "Online checks" strip that
-- updates live while the TinyFish job runs. This migration adds:
--   1. Realtime publication for the two tables the card subscribes to.
--   2. Owner-scoped read access to a patient's own online-check jobs
--      (tinyfish_jobs was server-only before; the patient may now see the
--      status of their own job, nothing else).
--   3. A deterministic, pg_trgm-based matcher for official (NSQ) alerts,
--      so the risk engine can flag a batch that appears in nsq_alerts.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Realtime publication
-- ------------------------------------------------------------
-- Supabase exposes a `supabase_realtime` publication. Add the tables the
-- trust card subscribes to. Guarded so re-running this migration is safe and
-- so it does not fail on projects where the publication is absent.
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'online_verifications'
        ) then
            alter publication supabase_realtime add table public.online_verifications;
        end if;

        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'tinyfish_jobs'
        ) then
            alter publication supabase_realtime add table public.tinyfish_jobs;
        end if;
    end if;
end
$$;

-- ------------------------------------------------------------
-- 2. tinyfish_jobs: owner-scoped SELECT
-- ------------------------------------------------------------
-- Clients could not read jobs at all (no policy). The trust card needs the
-- status of the job for the medicine the signed-in patient owns, and
-- Realtime needs a SELECT policy to deliver those rows. Everything else
-- (global alert_sync jobs, other patients' jobs) stays invisible.
create policy tinyfish_jobs_select_owner
on public.tinyfish_jobs for select to authenticated
using (
    medicine_id is not null
    and public.owns_medicine(medicine_id)
);

grant select on public.tinyfish_jobs to authenticated;

-- ------------------------------------------------------------
-- 3. NSQ alert normalisation + matching
-- ------------------------------------------------------------
-- Same normalisation for both stored rows and query terms, so matching is
-- deterministic. Keep these two functions in sync: they are the contract for
-- nsq_alerts.product_name_norm / batch_no_norm.
create or replace function public.normalize_product_name(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
    select btrim(regexp_replace(lower(coalesce(p_value, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

create or replace function public.normalize_batch_no(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
    select upper(regexp_replace(coalesce(p_value, ''), '[^a-z0-9]+', '', 'gi'));
$$;

-- Keep the normalised columns correct no matter how rows are imported.
create or replace function public.set_nsq_alert_norms()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.product_name_norm := public.normalize_product_name(new.product_name);
    new.batch_no_norm := public.normalize_batch_no(new.batch_no);
    return new;
end;
$$;

drop trigger if exists nsq_alerts_set_norms on public.nsq_alerts;

create trigger nsq_alerts_set_norms
before insert or update of product_name, batch_no
on public.nsq_alerts
for each row execute function public.set_nsq_alert_norms();

-- Fuzzy-match a medicine name (and optionally its batch) against nsq_alerts.
-- Returns name_and_batch matches first, then name_only, both order by
-- similarity. security definer + empty search_path; similarity() is qualified
-- because pg_trgm lives in the "extensions" schema.
create or replace function public.match_nsq_alerts(
    p_product_name text,
    p_batch_no text default null,
    p_threshold real default 0.4,
    p_limit integer default 5
)
returns table (
    alert_type text,
    product_name text,
    batch_no text,
    alert_date date,
    source_url text,
    match_type text,
    similarity real
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        a.alert_type,
        a.product_name,
        a.batch_no,
        a.alert_date,
        a.source_url,
        case
            when public.normalize_batch_no(p_batch_no) <> ''
             and a.batch_no_norm = public.normalize_batch_no(p_batch_no)
            then 'name_and_batch'
            else 'name_only'
        end as match_type,
        extensions.similarity(
            a.product_name_norm,
            public.normalize_product_name(p_product_name)
        ) as similarity
    from public.nsq_alerts a
    where public.normalize_product_name(p_product_name) <> ''
      and extensions.similarity(
              a.product_name_norm,
              public.normalize_product_name(p_product_name)
          ) >= p_threshold
    order by
        (case
            when public.normalize_batch_no(p_batch_no) <> ''
             and a.batch_no_norm = public.normalize_batch_no(p_batch_no)
            then 0
            else 1
        end),
        extensions.similarity(
            a.product_name_norm,
            public.normalize_product_name(p_product_name)
        ) desc,
        a.alert_date desc
    limit greatest(1, least(coalesce(p_limit, 5), 20));
$$;

-- ------------------------------------------------------------
-- 4. Privilege hardening
-- ------------------------------------------------------------
revoke all on function public.normalize_product_name(text) from public, anon;
revoke all on function public.normalize_batch_no(text) from public, anon;
revoke all on function public.match_nsq_alerts(text, text, real, integer)
    from public, anon;

grant execute on function public.normalize_product_name(text)
    to authenticated, service_role;
grant execute on function public.normalize_batch_no(text)
    to authenticated, service_role;
grant execute on function public.match_nsq_alerts(text, text, real, integer)
    to authenticated, service_role;
