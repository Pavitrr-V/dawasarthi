
-- ============================================================
-- MedScan | Initial Supabase Migration
-- File: supabase/migrations/001_init.sql
-- ============================================================
-- IMPORTANT:
-- 1. Run using the Supabase SQL Editor or a privileged migration role.
-- 2. Never expose the service-role key to the browser.
-- 3. Storage deletion assumes uploaded objects are owned by the
--    user's UUID or stored under a user/patient UUID path prefix.
-- 4. Caregiver acceptance is restricted by a trigger so a
--    caregiver cannot grant themselves patient consent.
-- ============================================================

begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ------------------------------------------------------------
-- 1. TABLES
-- ------------------------------------------------------------

create table public.users (
    id uuid primary key references auth.users(id) on delete cascade,
    role text not null check (role in ('patient', 'caregiver')),
    name text,
    phone text,
    language text not null default 'en',
    created_at timestamptz not null default now()
);

create table public.patients (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null references public.users(id) on delete cascade,
    name text not null,
    age integer check (age is null or age between 0 and 150),
    allergies text[] not null default '{}',
    conditions text[] not null default '{}',
    breakfast_time time,
    lunch_time time,
    dinner_time time,
    escalation_repeat_minutes integer not null default 10
        check (escalation_repeat_minutes > 0),
    escalation_caregiver_minutes integer not null default 30
        check (escalation_caregiver_minutes > 0),
    created_at timestamptz not null default now()
);

create table public.caregiver_links (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references public.patients(id) on delete cascade,
    caregiver_user_id uuid references public.users(id) on delete set null,
    invite_code text not null unique default encode(gen_random_bytes(24), 'hex'),
    consent_given boolean not null default false,
    consent_at timestamptz,
    status text not null default 'pending'
        check (status in ('pending', 'active', 'revoked')),
    caregiver_phone text,
    created_at timestamptz not null default now(),
    unique (patient_id, caregiver_user_id)
);

create table public.medicines (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid not null references public.patients(id) on delete cascade,
    name text not null,
    composition text[] not null default '{}',
    batch_no text,
    mfg_date date,
    expiry_date date,
    mrp numeric(12,2) check (mrp is null or mrp >= 0),
    license_no text,
    barcode text,
    manufacturer text,
    risk_level text not null default 'amber'
        check (risk_level in ('green', 'amber', 'red')),
    risk_reasons jsonb not null default '[]'::jsonb,
    info jsonb not null default '{}'::jsonb,
    strip_image_path text,
    box_image_path text,
    created_at timestamptz not null default now(),
    check (expiry_date is null or mfg_date is null or expiry_date >= mfg_date)
);

create table public.schedules (
    id uuid primary key default gen_random_uuid(),
    medicine_id uuid not null references public.medicines(id) on delete cascade,
    patient_id uuid not null references public.patients(id) on delete cascade,
    times time[] not null default '{}',
    days_pattern text not null default 'daily'
        check (days_pattern in ('daily', 'alternate', 'weekdays', 'as_needed')),
    weekdays integer[] not null default '{}',
    meal_link text,
    start_date date not null default current_date,
    duration_days integer check (duration_days is null or duration_days > 0),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint schedules_weekdays_valid
        check (weekdays <@ array[0,1,2,3,4,5,6]::integer[]),
    constraint schedules_medicine_patient_match
        unique (id, patient_id)
);

create table public.dose_logs (
    id uuid primary key default gen_random_uuid(),
    schedule_id uuid not null,
    patient_id uuid not null references public.patients(id) on delete cascade,
    due_at timestamptz not null,
    status text not null default 'pending'
        check (status in ('pending', 'taken', 'skipped', 'snoozed', 'missed')),
    acted_at timestamptz,
    reminder_count integer not null default 0 check (reminder_count >= 0),
    last_reminder_at timestamptz,
    caregiver_alerted boolean not null default false,
    created_at timestamptz not null default now(),
    constraint dose_logs_schedule_patient_fk
        foreign key (schedule_id, patient_id)
        references public.schedules(id, patient_id) on delete cascade
);

create table public.inventory (
    id uuid primary key default gen_random_uuid(),
    medicine_id uuid not null unique references public.medicines(id) on delete cascade,
    quantity_left integer not null default 0 check (quantity_left >= 0),
    low_stock_threshold integer not null default 5
        check (low_stock_threshold >= 0),
    unit text not null default 'units'
);

create table public.reports (
    id uuid primary key default gen_random_uuid(),
    medicine_id uuid not null references public.medicines(id) on delete cascade,
    reporter_user_id uuid not null references public.users(id) on delete cascade,
    photo_path text,
    lat double precision,
    lng double precision,
    note text,
    created_at timestamptz not null default now(),
    check (lat is null or lat between -90 and 90),
    check (lng is null or lng between -180 and 180)
);

create table public.push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    endpoint text not null unique,
    p256dh text not null,
    auth text not null,
    created_at timestamptz not null default now()
);

create table public.medicine_catalog (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    composition text[] not null default '{}',
    manufacturer text,
    uses text,
    side_effects text,
    created_at timestamptz not null default now()
);

create table public.interaction_pairs (
    id uuid primary key default gen_random_uuid(),
    ingredient_a text not null,
    ingredient_b text not null,
    severity text not null,
    note text,
    created_at timestamptz not null default now(),
    check (lower(ingredient_a) <> lower(ingredient_b))
);

create table public.nsq_alerts (
    id uuid primary key default gen_random_uuid(),
    product_name text not null,
    product_name_norm text not null,
    batch_no text,
    batch_no_norm text not null default '',
    manufacturer text,
    alert_type text not null
        check (alert_type in ('nsq', 'spurious', 'adulterated', 'misbranded', 'other')),
    alert_date date not null,
    source_url text not null,
    fetched_at timestamptz not null default now(),
    raw jsonb not null default '{}'::jsonb,
    unique (product_name_norm, batch_no_norm, alert_date)
);

create table public.online_verifications (
    id uuid primary key default gen_random_uuid(),
    medicine_id uuid not null references public.medicines(id) on delete cascade,
    source_site text not null,
    source_url text not null,
    status text not null default 'pending'
        check (status in ('pending', 'found', 'not_found', 'error')),
    listed_name text,
    listed_mrp numeric(12,2) check (listed_mrp is null or listed_mrp >= 0),
    listed_manufacturer text,
    listed_pack_size text,
    confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
    fetched_at timestamptz,
    raw jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table public.price_quotes (
    id uuid primary key default gen_random_uuid(),
    medicine_id uuid not null references public.medicines(id) on delete cascade,
    source_site text not null,
    source_url text not null,
    price numeric(12,2) not null check (price >= 0),
    pack_size text,
    in_stock boolean,
    fetched_at timestamptz not null default now()
);

create table public.tinyfish_jobs (
    id uuid primary key default gen_random_uuid(),
    kind text not null check (kind in ('verify', 'price', 'alert_sync')),
    medicine_id uuid references public.medicines(id) on delete cascade,
    user_id uuid references public.users(id) on delete cascade,
    run_id text,
    status text not null default 'queued'
        check (status in ('queued', 'running', 'done', 'failed')),
    attempts integer not null default 0 check (attempts >= 0),
    error text,
    created_at timestamptz not null default now(),
    finished_at timestamptz
);

-- ------------------------------------------------------------
-- 2. INDEXES
-- ------------------------------------------------------------

create index patients_owner_idx
    on public.patients(owner_user_id);

create index caregiver_links_patient_idx
    on public.caregiver_links(patient_id);

create index caregiver_links_caregiver_idx
    on public.caregiver_links(caregiver_user_id);

create index medicines_patient_idx
    on public.medicines(patient_id);

create index schedules_patient_idx
    on public.schedules(patient_id);

create index schedules_medicine_idx
    on public.schedules(medicine_id);

create index dose_logs_status_due_idx
    on public.dose_logs(status, due_at);

create index dose_logs_patient_due_idx
    on public.dose_logs(patient_id, due_at desc);

create index inventory_medicine_idx
    on public.inventory(medicine_id);

create index reports_medicine_idx
    on public.reports(medicine_id);

create index reports_reporter_idx
    on public.reports(reporter_user_id);

create index push_subscriptions_user_idx
    on public.push_subscriptions(user_id);

create index medicine_catalog_name_trgm_idx
    on public.medicine_catalog using gin (name extensions.gin_trgm_ops);

create index interaction_pairs_ingredient_a_idx
    on public.interaction_pairs(lower(ingredient_a));

create index interaction_pairs_ingredient_b_idx
    on public.interaction_pairs(lower(ingredient_b));

create index nsq_alerts_product_name_norm_trgm_idx
    on public.nsq_alerts using gin (product_name_norm extensions.gin_trgm_ops);

create index online_verifications_medicine_idx
    on public.online_verifications(medicine_id, fetched_at desc);

create index price_quotes_medicine_idx
    on public.price_quotes(medicine_id, fetched_at desc);

create index tinyfish_jobs_status_idx
    on public.tinyfish_jobs(status);

create index tinyfish_jobs_user_created_idx
    on public.tinyfish_jobs(user_id, created_at desc);

-- ------------------------------------------------------------
-- 3. CONSISTENCY TRIGGERS
-- ------------------------------------------------------------

-- A schedule must reference a medicine belonging to the same patient.
create or replace function public.check_schedule_medicine_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.medicines m
        where m.id = new.medicine_id
          and m.patient_id = new.patient_id
    ) then
        raise exception 'Medicine does not belong to the specified patient';
    end if;

    return new;
end;
$$;

create trigger schedules_check_medicine_owner
before insert or update of medicine_id, patient_id
on public.schedules
for each row execute function public.check_schedule_medicine_owner();

-- A report can only reference a medicine belonging to the reporter,
-- unless the reporter is a caregiver with an active, consented link.
create or replace function public.check_report_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not exists (
        select 1
        from public.medicines m
        join public.patients p on p.id = m.patient_id
        where m.id = new.medicine_id
          and (
              p.owner_user_id = new.reporter_user_id
              or exists (
                  select 1
                  from public.caregiver_links cl
                  where cl.patient_id = p.id
                    and cl.caregiver_user_id = new.reporter_user_id
                    and cl.status = 'active'
                    and cl.consent_given = true
              )
          )
    ) then
        raise exception 'You cannot report on this medicine';
    end if;

    return new;
end;
$$;

create trigger reports_check_access
before insert or update of medicine_id, reporter_user_id
on public.reports
for each row execute function public.check_report_access();

-- Caregiver acceptance must not allow self-granted consent.
create or replace function public.protect_caregiver_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_phone text;
begin
    if v_uid is null then
        return new;
    end if;

    -- The patient owner may create/revoke links and grant or withdraw consent.
    if exists (
        select 1
        from public.patients p
        where p.id = coalesce(new.patient_id, old.patient_id)
          and p.owner_user_id = v_uid
    ) then
        if tg_op = 'UPDATE'
           and old.consent_given is distinct from new.consent_given then
            if new.consent_given then
                new.consent_at := coalesce(new.consent_at, now());
            else
                new.consent_at := null;
            end if;
        end if;
        return new;
    end if;

    if tg_op <> 'UPDATE' then
        raise exception 'Only the patient owner can create caregiver invitations';
    end if;

    select u.phone into v_phone
    from public.users u
    where u.id = v_uid;

    -- An invite can be accepted only by the invited phone number, or
    -- by the caregiver already assigned to the invitation.
    if not (
        old.caregiver_user_id = v_uid
        or (
            old.caregiver_user_id is null
            and old.caregiver_phone is not null
            and v_phone is not null
            and old.caregiver_phone = v_phone
        )
    ) then
        raise exception 'This invitation does not belong to you';
    end if;

    if new.patient_id is distinct from old.patient_id
       or new.invite_code is distinct from old.invite_code
       or new.consent_given is distinct from old.consent_given
       or new.consent_at is distinct from old.consent_at
       or new.caregiver_phone is distinct from old.caregiver_phone
       or new.created_at is distinct from old.created_at then
        raise exception 'Caregivers cannot change invitation ownership or consent';
    end if;

    if new.caregiver_user_id is distinct from v_uid then
        raise exception 'Invalid caregiver assignment';
    end if;

    if new.status not in ('active', 'revoked') then
        raise exception 'Invalid invitation status';
    end if;

    return new;
end;
$$;

create trigger caregiver_links_protect
before insert or update
on public.caregiver_links
for each row execute function public.protect_caregiver_link();

-- ------------------------------------------------------------
-- 4. SECURITY-DEFINER HELPERS FOR RLS
-- ------------------------------------------------------------

-- These functions avoid recursive RLS evaluation when policies check
-- caregiver_links or traverse a medicine/schedule to its patient.

create or replace function public.owns_patient(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.patients p
        where p.id = p_patient_id
          and p.owner_user_id = (select auth.uid())
    );
$$;

create or replace function public.can_view_patient(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.patients p
        where p.id = p_patient_id
          and (
              p.owner_user_id = (select auth.uid())
              or exists (
                  select 1
                  from public.caregiver_links cl
                  where cl.patient_id = p.id
                    and cl.caregiver_user_id = (select auth.uid())
                    and cl.status = 'active'
                    and cl.consent_given = true
              )
          )
    );
$$;

create or replace function public.owns_medicine(p_medicine_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.medicines m
        join public.patients p on p.id = m.patient_id
        where m.id = p_medicine_id
          and p.owner_user_id = (select auth.uid())
    );
$$;

create or replace function public.owns_schedule(p_schedule_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.schedules s
        join public.patients p on p.id = s.patient_id
        where s.id = p_schedule_id
          and p.owner_user_id = (select auth.uid())
    );
$$;

create or replace function public.owns_report_medicine(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.reports r
        where r.id = p_report_id
          and r.reporter_user_id = (select auth.uid())
    );
$$;

-- Prevent untrusted roles from calling internal ownership helpers.
revoke all on function public.owns_patient(uuid) from public, anon;
revoke all on function public.can_view_patient(uuid) from public, anon;
revoke all on function public.owns_medicine(uuid) from public, anon;
revoke all on function public.owns_schedule(uuid) from public, anon;
revoke all on function public.owns_report_medicine(uuid) from public, anon;

grant execute on function public.owns_patient(uuid) to authenticated, service_role;
grant execute on function public.can_view_patient(uuid) to authenticated, service_role;
grant execute on function public.owns_medicine(uuid) to authenticated, service_role;
grant execute on function public.owns_schedule(uuid) to authenticated, service_role;
grant execute on function public.owns_report_medicine(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. ENABLE ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table public.users enable row level security;
alter table public.patients enable row level security;
alter table public.caregiver_links enable row level security;
alter table public.medicines enable row level security;
alter table public.schedules enable row level security;
alter table public.dose_logs enable row level security;
alter table public.inventory enable row level security;
alter table public.reports enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.medicine_catalog enable row level security;
alter table public.interaction_pairs enable row level security;
alter table public.nsq_alerts enable row level security;
alter table public.online_verifications enable row level security;
alter table public.price_quotes enable row level security;
alter table public.tinyfish_jobs enable row level security;

-- ------------------------------------------------------------
-- 6. USERS
-- ------------------------------------------------------------

create policy users_select_self
on public.users for select to authenticated
using (id = (select auth.uid()));

create policy users_insert_self
on public.users for insert to authenticated
with check (id = (select auth.uid()));

create policy users_update_self
on public.users for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- ------------------------------------------------------------
-- 7. PATIENTS
-- ------------------------------------------------------------

create policy patients_select_authorized
on public.patients for select to authenticated
using (public.can_view_patient(id));

create policy patients_insert_owner
on public.patients for insert to authenticated
with check (owner_user_id = (select auth.uid()));

create policy patients_update_owner
on public.patients for update to authenticated
using (owner_user_id = (select auth.uid()))
with check (owner_user_id = (select auth.uid()));

create policy patients_delete_owner
on public.patients for delete to authenticated
using (owner_user_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 8. CAREGIVER LINKS
-- ------------------------------------------------------------

create policy caregiver_links_select_owner_or_invitee
on public.caregiver_links for select to authenticated
using (
    public.owns_patient(patient_id)
    or caregiver_user_id = (select auth.uid())
    or (
        caregiver_user_id is null
        and caregiver_phone is not null
        and caregiver_phone = (
            select u.phone from public.users u
            where u.id = (select auth.uid())
        )
    )
);

create policy caregiver_links_insert_owner
on public.caregiver_links for insert to authenticated
with check (public.owns_patient(patient_id));

create policy caregiver_links_update_owner
on public.caregiver_links for update to authenticated
using (public.owns_patient(patient_id))
with check (public.owns_patient(patient_id));

create policy caregiver_links_update_caregiver
on public.caregiver_links for update to authenticated
using (
    caregiver_user_id = (select auth.uid())
    or (
        caregiver_user_id is null
        and caregiver_phone is not null
        and caregiver_phone = (
            select u.phone from public.users u
            where u.id = (select auth.uid())
        )
    )
)
with check (caregiver_user_id = (select auth.uid()));

create policy caregiver_links_delete_owner
on public.caregiver_links for delete to authenticated
using (public.owns_patient(patient_id));

-- ------------------------------------------------------------
-- 9. MEDICINES
-- Owners have full access. Consented caregivers have SELECT only.
-- ------------------------------------------------------------

create policy medicines_select_authorized
on public.medicines for select to authenticated
using (public.can_view_patient(patient_id));

create policy medicines_insert_owner
on public.medicines for insert to authenticated
with check (public.owns_patient(patient_id));

create policy medicines_update_owner
on public.medicines for update to authenticated
using (public.owns_patient(patient_id))
with check (public.owns_patient(patient_id));

create policy medicines_delete_owner
on public.medicines for delete to authenticated
using (public.owns_patient(patient_id));

-- ------------------------------------------------------------
-- 10. SCHEDULES
-- ------------------------------------------------------------

create policy schedules_select_authorized
on public.schedules for select to authenticated
using (public.can_view_patient(patient_id));

create policy schedules_insert_owner
on public.schedules for insert to authenticated
with check (public.owns_patient(patient_id));

create policy schedules_update_owner
on public.schedules for update to authenticated
using (public.owns_patient(patient_id))
with check (public.owns_patient(patient_id));

create policy schedules_delete_owner
on public.schedules for delete to authenticated
using (public.owns_patient(patient_id));

-- ------------------------------------------------------------
-- 11. DOSE LOGS
-- ------------------------------------------------------------

create policy dose_logs_select_authorized
on public.dose_logs for select to authenticated
using (public.can_view_patient(patient_id));

create policy dose_logs_insert_owner
on public.dose_logs for insert to authenticated
with check (
    public.owns_patient(patient_id)
    and public.owns_schedule(schedule_id)
);

create policy dose_logs_update_owner
on public.dose_logs for update to authenticated
using (public.owns_patient(patient_id))
with check (
    public.owns_patient(patient_id)
    and public.owns_schedule(schedule_id)
);

create policy dose_logs_delete_owner
on public.dose_logs for delete to authenticated
using (public.owns_patient(patient_id));

-- ------------------------------------------------------------
-- 12. INVENTORY (patient owner only)
-- ------------------------------------------------------------

create policy inventory_select_owner
on public.inventory for select to authenticated
using (public.owns_medicine(medicine_id));

create policy inventory_insert_owner
on public.inventory for insert to authenticated
with check (public.owns_medicine(medicine_id));

create policy inventory_update_owner
on public.inventory for update to authenticated
using (public.owns_medicine(medicine_id))
with check (public.owns_medicine(medicine_id));

create policy inventory_delete_owner
on public.inventory for delete to authenticated
using (public.owns_medicine(medicine_id));

-- ------------------------------------------------------------
-- 13. REPORTS
-- Any authenticated user may submit a report for an accessible
-- medicine. Users may read their own reports.
-- ------------------------------------------------------------

create policy reports_insert_authenticated
on public.reports for insert to authenticated
with check (
    reporter_user_id = (select auth.uid())
    and exists (
        select 1
        from public.medicines m
        where m.id = medicine_id
          and public.can_view_patient(m.patient_id)
    )
);

create policy reports_select_reporter
on public.reports for select to authenticated
using (reporter_user_id = (select auth.uid()));

create policy reports_update_reporter
on public.reports for update to authenticated
using (reporter_user_id = (select auth.uid()))
with check (reporter_user_id = (select auth.uid()));

create policy reports_delete_reporter
on public.reports for delete to authenticated
using (reporter_user_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 14. PUSH SUBSCRIPTIONS
-- ------------------------------------------------------------

create policy push_subscriptions_select_self
on public.push_subscriptions for select to authenticated
using (user_id = (select auth.uid()));

create policy push_subscriptions_insert_self
on public.push_subscriptions for insert to authenticated
with check (user_id = (select auth.uid()));

create policy push_subscriptions_update_self
on public.push_subscriptions for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy push_subscriptions_delete_self
on public.push_subscriptions for delete to authenticated
using (user_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 15. SHARED READ-ONLY REFERENCE DATA
-- All authenticated users can read. Client writes are not granted.
-- ------------------------------------------------------------

create policy medicine_catalog_read_authenticated
on public.medicine_catalog for select to authenticated
using (true);

create policy interaction_pairs_read_authenticated
on public.interaction_pairs for select to authenticated
using (true);

create policy nsq_alerts_read_authenticated
on public.nsq_alerts for select to authenticated
using (true);

-- ------------------------------------------------------------
-- 16. ONLINE VERIFICATIONS (owner access via medicine)
-- ------------------------------------------------------------

create policy online_verifications_select_owner
on public.online_verifications for select to authenticated
using (public.owns_medicine(medicine_id));

create policy online_verifications_insert_owner
on public.online_verifications for insert to authenticated
with check (public.owns_medicine(medicine_id));

create policy online_verifications_update_owner
on public.online_verifications for update to authenticated
using (public.owns_medicine(medicine_id))
with check (public.owns_medicine(medicine_id));

create policy online_verifications_delete_owner
on public.online_verifications for delete to authenticated
using (public.owns_medicine(medicine_id));

-- ------------------------------------------------------------
-- 17. PRICE QUOTES (owner access via medicine)
-- ------------------------------------------------------------

create policy price_quotes_select_owner
on public.price_quotes for select to authenticated
using (public.owns_medicine(medicine_id));

create policy price_quotes_insert_owner
on public.price_quotes for insert to authenticated
with check (public.owns_medicine(medicine_id));

create policy price_quotes_update_owner
on public.price_quotes for update to authenticated
using (public.owns_medicine(medicine_id))
with check (public.owns_medicine(medicine_id));

create policy price_quotes_delete_owner
on public.price_quotes for delete to authenticated
using (public.owns_medicine(medicine_id));

-- ------------------------------------------------------------
-- 18. TINYFISH JOBS: NO CLIENT POLICIES
-- RLS is enabled and no policies are defined, so authenticated
-- and anonymous clients cannot read or write these rows.
-- Server operations must use the service role.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 19. PRIVILEGE HARDENING
-- RLS is not a replacement for SQL privileges.
-- ------------------------------------------------------------

revoke all on public.tinyfish_jobs from anon, authenticated;
revoke all on public.medicine_catalog from anon, authenticated;
revoke all on public.interaction_pairs from anon, authenticated;
revoke all on public.nsq_alerts from anon, authenticated;

grant select, insert, update, delete on public.users to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update, delete on public.caregiver_links to authenticated;
grant select, insert, update, delete on public.medicines to authenticated;
grant select, insert, update, delete on public.schedules to authenticated;
grant select, insert, update, delete on public.dose_logs to authenticated;
grant select, insert, update, delete on public.inventory to authenticated;
grant select, insert, update, delete on public.reports to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select on public.medicine_catalog to authenticated;
grant select on public.interaction_pairs to authenticated;
grant select on public.nsq_alerts to authenticated;
grant select, insert, update, delete on public.online_verifications to authenticated;
grant select, insert, update, delete on public.price_quotes to authenticated;

grant all on public.tinyfish_jobs to service_role;
grant all on public.medicine_catalog to service_role;
grant all on public.interaction_pairs to service_role;
grant all on public.nsq_alerts to service_role;

-- ------------------------------------------------------------
-- 20. CREATE USER PROFILE ON AUTH SIGNUP
-- The client should supply user_metadata.role as 'patient' or
-- 'caregiver'. Invalid/missing values safely default to 'patient'.
-- ------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_role text;
begin
    v_role := new.raw_user_meta_data ->> 'role';

    if v_role not in ('patient', 'caregiver') or v_role is null then
        v_role := 'patient';
    end if;

    insert into public.users (id, role, name, phone, language)
    values (
        new.id,
        v_role,
        nullif(new.raw_user_meta_data ->> 'name', ''),
        new.phone,
        coalesce(nullif(new.raw_user_meta_data ->> 'language', ''), 'en')
    )
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 21. DELETE ALL DATA BELONGING TO THE CURRENT USER
-- Deletes the user's profile, owned patients and descendants,
-- caregiver links, reports, push subscriptions, and owned storage
-- objects. Shared reference data is retained.
--
-- Storage convention: store uploads beneath a user UUID or patient
-- UUID prefix, e.g. <user_uuid>/... or <patient_uuid>/...
-- ------------------------------------------------------------

create or replace function public.delete_all_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_patient_ids uuid[];
    v_deleted_objects integer := 0;
begin
    if v_uid is null then
        raise exception 'Authentication required';
    end if;

    select coalesce(array_agg(p.id), '{}'::uuid[])
    into v_patient_ids
    from public.patients p
    where p.owner_user_id = v_uid;

    -- Remove database records that do not cascade from users/patients.
    delete from public.push_subscriptions
    where user_id = v_uid;

    delete from public.reports
    where reporter_user_id = v_uid
       or medicine_id in (
            select m.id
            from public.medicines m
            where m.patient_id = any(v_patient_ids)
       );

    -- Delete caregiver links created for owned patients or accepted
    -- by this user. Patient-owned cascades also remove child data.
    delete from public.caregiver_links
    where patient_id = any(v_patient_ids)
       or caregiver_user_id = v_uid;

    -- Delete storage object metadata. Objects should use the stated
    -- UUID-prefix convention or owner_id set by Storage.
    delete from storage.objects o
    where o.owner_id = v_uid::text
       or o.name like v_uid::text || '/%'
       or exists (
           select 1
           from unnest(v_patient_ids) as pid
           where o.name like pid::text || '/%'
       );

    get diagnostics v_deleted_objects = row_count;

    -- Remove patients and all cascading child rows.
    delete from public.patients
    where owner_user_id = v_uid;

    -- Remove user-specific jobs and account.
    delete from public.tinyfish_jobs
    where user_id = v_uid;

    delete from public.users
    where id = v_uid;

    -- Delete the Supabase Auth account last.
    delete from auth.users
    where id = v_uid;

    return jsonb_build_object(
        'success', true,
        'deleted_storage_objects', v_deleted_objects
    );
end;
$$;

revoke all on function public.delete_all_my_data() from public, anon;
grant execute on function public.delete_all_my_data() to authenticated;

commit;

-- ============================================================
-- END OF MIGRATION
-- ============================================================
