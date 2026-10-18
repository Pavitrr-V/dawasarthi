create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  name text
);
create table if not exists medicines (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  name text not null,
  trust_color text check (trust_color in ('green','amber','red')) not null,
  expiry_date date not null,
  quantity int not null default 0,
  low_stock_threshold int not null default 0,
  unit text not null default 'tablets',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id) on delete cascade,
  endpoint text not null,
  keys jsonb not null,
  created_at timestamp with time zone default now()
);
-- RLS: user owns patient or caregiver with consent (simplified for hackathon)
alter table patients enable row level security;
alter table medicines enable row level security;
alter table push_subscriptions enable row level security;