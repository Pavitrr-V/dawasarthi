-- ============================================================
-- MedScan | Reminder worker support
-- File: supabase/migrations/012_reminder_worker.sql
-- ============================================================
-- Supports GET /api/cron/tick (lib/reminder-tick.ts):
--   * notification_log  - every push/SMS/WhatsApp attempt is recorded.
--   * cron_state        - singleton markers so daily/weekly jobs run once.
--   * tinyfish_jobs.locked_at - a lease so overlapping ticks never double-poll.
--   * claim_* functions - the atomic UPDATE ... RETURNING claim step that
--     makes every reminder idempotent (two overlapping ticks can never
--     double-send: the second one sees zero rows to claim).
--
-- All claim functions are SECURITY DEFINER with an empty search_path so they
-- can only touch the tables written here, and are executable by the
-- service_role only.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. notification_log
-- ------------------------------------------------------------
create table if not exists public.notification_log (
    id uuid primary key default gen_random_uuid(),
    -- Who received it (patient owner account or caregiver account).
    user_id uuid references public.users(id) on delete set null,
    patient_id uuid references public.patients(id) on delete cascade,
    dose_id uuid references public.dose_logs(id) on delete cascade,
    channel text not null check (channel in ('push', 'sms', 'whatsapp')),
    status text not null check (status in ('sent', 'failed', 'skipped')),
    to_phone text,
    error text,
    attempts integer not null default 1 check (attempts >= 0),
    created_at timestamptz not null default now()
);

create index if not exists notification_log_dose_idx
    on public.notification_log(dose_id, created_at desc);

create index if not exists notification_log_created_idx
    on public.notification_log(created_at desc);

alter table public.notification_log enable row level security;

-- Server-only: the cron worker uses the service role, which bypasses RLS.
revoke all on public.notification_log from anon, authenticated;
grant all on public.notification_log to service_role;

-- ------------------------------------------------------------
-- 2. cron_state (singleton run markers)
-- ------------------------------------------------------------
create table if not exists public.cron_state (
    key text primary key,
    ran_at timestamptz not null default now()
);

alter table public.cron_state enable row level security;

revoke all on public.cron_state from anon, authenticated;
grant all on public.cron_state to service_role;

-- ------------------------------------------------------------
-- 3. tinyfish_jobs lease column
-- ------------------------------------------------------------
-- `attempts` already exists in 001_init.sql; only the lease is new.
alter table public.tinyfish_jobs add column if not exists locked_at timestamptz;

create index if not exists tinyfish_jobs_claim_idx
    on public.tinyfish_jobs(status, locked_at);

-- ------------------------------------------------------------
-- 4. Reminder claim functions
-- ------------------------------------------------------------
-- Each one atomically claims a bounded batch by updating the guarded columns,
-- so a second, overlapping tick matches zero rows.

-- Step 1: first reminder (reminder_count 0 -> 1).
create or replace function public.claim_first_reminders(p_limit integer default 20)
returns table (
    dose_id uuid,
    patient_id uuid,
    owner_user_id uuid,
    patient_name text,
    medicine_name text,
    due_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
    with claimed as (
        select d.id
        from public.dose_logs d
        where d.status = 'pending'
          and d.due_at <= now()
          and d.reminder_count = 0
        order by d.due_at
        limit greatest(p_limit, 1)
        for update skip locked
    ),
    updated as (
        update public.dose_logs d
        set reminder_count = 1, last_reminder_at = now()
        from claimed c
        where d.id = c.id
        returning d.id
    )
    select d.id, d.patient_id, p.owner_user_id, p.name, m.name, d.due_at
    from updated u
    join public.dose_logs d on d.id = u.id
    join public.patients p on p.id = d.patient_id
    join public.schedules s on s.id = d.schedule_id
    join public.medicines m on m.id = s.medicine_id;
$$;

-- Step 2: repeat reminder (reminder_count 1 -> 2) once the patient-configured
-- repeat delay has elapsed since the dose was due.
create or replace function public.claim_repeat_reminders(p_limit integer default 20)
returns table (
    dose_id uuid,
    patient_id uuid,
    owner_user_id uuid,
    patient_name text,
    medicine_name text,
    due_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
    with claimed as (
        select d.id
        from public.dose_logs d
        join public.patients p on p.id = d.patient_id
        where d.status = 'pending'
          and d.reminder_count = 1
          and now() >= d.due_at + make_interval(mins => p.escalation_repeat_minutes)
        order by d.due_at
        limit greatest(p_limit, 1)
        for update of d skip locked
    ),
    updated as (
        update public.dose_logs d
        set reminder_count = 2, last_reminder_at = now()
        from claimed c
        where d.id = c.id
        returning d.id
    )
    select d.id, d.patient_id, p.owner_user_id, p.name, m.name, d.due_at
    from updated u
    join public.dose_logs d on d.id = u.id
    join public.patients p on p.id = d.patient_id
    join public.schedules s on s.id = d.schedule_id
    join public.medicines m on m.id = s.medicine_id;
$$;

-- Step 3: caregiver escalation. Marks the dose missed exactly once
-- (caregiver_alerted false -> true) and returns the rows to notify about.
create or replace function public.claim_caregiver_escalations(p_limit integer default 20)
returns table (
    dose_id uuid,
    patient_id uuid,
    owner_user_id uuid,
    patient_name text,
    medicine_name text,
    due_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
    with claimed as (
        select d.id
        from public.dose_logs d
        join public.patients p on p.id = d.patient_id
        where d.status = 'pending'
          and d.caregiver_alerted = false
          and now() >= d.due_at + make_interval(mins => p.escalation_caregiver_minutes)
        order by d.due_at
        limit greatest(p_limit, 1)
        for update of d skip locked
    ),
    updated as (
        update public.dose_logs d
        set status = 'missed', caregiver_alerted = true
        from claimed c
        where d.id = c.id
        returning d.id
    )
    select d.id, d.patient_id, p.owner_user_id, p.name, m.name, d.due_at
    from updated u
    join public.dose_logs d on d.id = u.id
    join public.patients p on p.id = d.patient_id
    join public.schedules s on s.id = d.schedule_id
    join public.medicines m on m.id = s.medicine_id;
$$;

-- Step 4: claim the once-a-day dose top-up. Returns true only for the tick
-- that actually claims the run (the WHERE on DO UPDATE blocks re-runs).
create or replace function public.claim_daily_top_up()
returns boolean
language sql
security definer
set search_path = ''
as $$
    with claimed as (
        insert into public.cron_state(key, ran_at)
        values ('dose_top_up', now())
        on conflict (key) do update set ran_at = excluded.ran_at
        where public.cron_state.ran_at < now() - interval '20 hours'
        returning key
    )
    select exists(select 1 from claimed);
$$;

-- ------------------------------------------------------------
-- 5. TinyFish job lease + failure helpers
-- ------------------------------------------------------------
-- Claims up to p_limit queued/running jobs by taking a 2-minute lease and
-- normalising 'queued' -> 'running'. `for update skip locked` means two
-- overlapping ticks claim disjoint sets.
create or replace function public.claim_tinyfish_jobs(p_limit integer default 10)
returns setof public.tinyfish_jobs
language sql
security definer
set search_path = ''
as $$
    with claimed as (
        select id
        from public.tinyfish_jobs
        where status in ('queued', 'running')
          and (locked_at is null or locked_at < now() - interval '2 minutes')
        order by created_at
        limit greatest(p_limit, 1)
        for update skip locked
    )
    update public.tinyfish_jobs j
    set status = 'running', locked_at = now()
    from claimed c
    where j.id = c.id
    returning j.*;
$$;

-- Fails a claimed job and increments its attempt counter.
create or replace function public.mark_job_failed(p_id uuid, p_error text)
returns boolean
language sql
security definer
set search_path = ''
as $$
    with updated as (
        update public.tinyfish_jobs
        set status = 'failed',
            error = left(coalesce(p_error, 'Agent run failed.'), 500),
            finished_at = now(),
            attempts = attempts + 1
        where id = p_id
          and status in ('queued', 'running')
        returning id
    )
    select exists(select 1 from updated);
$$;

-- Bumps the attempt counter on a job a finisher already marked failed.
create or replace function public.bump_job_attempts(p_id uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
    with updated as (
        update public.tinyfish_jobs
        set attempts = attempts + 1
        where id = p_id
        returning attempts
    )
    select coalesce(max(attempts), 0) from updated;
$$;

-- ------------------------------------------------------------
-- 6. Lock down execution
-- ------------------------------------------------------------
revoke all on function public.claim_first_reminders(integer) from public, anon, authenticated;
revoke all on function public.claim_repeat_reminders(integer) from public, anon, authenticated;
revoke all on function public.claim_caregiver_escalations(integer) from public, anon, authenticated;
revoke all on function public.claim_daily_top_up() from public, anon, authenticated;
revoke all on function public.claim_tinyfish_jobs(integer) from public, anon, authenticated;
revoke all on function public.mark_job_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.bump_job_attempts(uuid) from public, anon, authenticated;

grant execute on function public.claim_first_reminders(integer) to service_role;
grant execute on function public.claim_repeat_reminders(integer) to service_role;
grant execute on function public.claim_caregiver_escalations(integer) to service_role;
grant execute on function public.claim_daily_top_up() to service_role;
grant execute on function public.claim_tinyfish_jobs(integer) to service_role;
grant execute on function public.mark_job_failed(uuid, text) to service_role;
grant execute on function public.bump_job_attempts(uuid) to service_role;

commit;
