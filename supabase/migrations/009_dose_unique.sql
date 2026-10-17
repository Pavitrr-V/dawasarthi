create unique index if not exists dose_logs_schedule_due_uniq
  on public.dose_logs (schedule_id, due_at);