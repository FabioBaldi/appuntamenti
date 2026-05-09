create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  full_name text not null,
  role text not null check (role in ('admin', 'user')),
  is_platform_owner boolean not null default false,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  owner_admin_id uuid references public.app_users(id) on delete set null,
  logo_data_url text,
  password_hash text not null,
  password_salt text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_users
  add column if not exists is_platform_owner boolean not null default false;

alter table public.app_users
  add column if not exists created_by_user_id uuid references public.app_users(id) on delete set null;

alter table public.app_users
  add column if not exists owner_admin_id uuid references public.app_users(id) on delete set null;

alter table public.app_users
  add column if not exists logo_data_url text;

create unique index if not exists app_users_username_lower_idx
on public.app_users (lower(username));

create index if not exists app_users_owner_admin_idx
on public.app_users (owner_admin_id);

create index if not exists app_users_created_by_user_idx
on public.app_users (created_by_user_id);

create table if not exists public.admin_channel_configs (
  brand_owner_user_id uuid primary key references public.app_users(id) on delete cascade,
  whatsapp_mode text not null default 'system' check (whatsapp_mode in ('system', 'meta_cloud')),
  meta_access_token_encrypted text,
  meta_phone_number_id text,
  meta_waba_id text,
  meta_business_account_id text,
  meta_display_phone_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  service text not null,
  description text,
  client_name text not null,
  client_email text,
  client_phone text,
  location text,
  notes text,
  start_at timestamptz not null,
  end_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  assigned_user_id uuid not null references public.app_users(id) on delete restrict,
  created_by_user_id uuid not null references public.app_users(id) on delete restrict,
  reminder_enabled boolean not null default false,
  reminder_minutes_before integer not null default 60,
  reminder_channels jsonb not null default '[]'::jsonb,
  reminder_message text,
  reminder_fingerprint text not null,
  reminder_version uuid not null default gen_random_uuid(),
  reminder_state jsonb not null default '{"version":"","sentChannels":[],"failedChannels":[],"lastAttemptAt":null,"lastErrorByChannel":{}}'::jsonb,
  reminder_logs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointments_assigned_user_idx
on public.appointments (assigned_user_id);

create index if not exists appointments_start_at_idx
on public.appointments (start_at);

create index if not exists appointments_status_idx
on public.appointments (status);

drop trigger if exists trg_app_users_updated_at on public.app_users;
create trigger trg_app_users_updated_at
before update on public.app_users
for each row
execute function public.set_updated_at();

drop trigger if exists trg_admin_channel_configs_updated_at on public.admin_channel_configs;
create trigger trg_admin_channel_configs_updated_at
before update on public.admin_channel_configs
for each row
execute function public.set_updated_at();

drop trigger if exists trg_appointments_updated_at on public.appointments;
create trigger trg_appointments_updated_at
before update on public.appointments
for each row
execute function public.set_updated_at();

update public.app_users
set owner_admin_id = id
where role = 'admin'
  and owner_admin_id is null;

update public.app_users
set is_platform_owner = true
where role = 'admin'
  and owner_admin_id = id
  and created_at = (
    select min(created_at) from public.app_users root_admin where root_admin.role = 'admin'
  );

update public.app_users
set created_by_user_id = id
where is_platform_owner = true
  and created_by_user_id is null;

update public.app_users
set created_by_user_id = (
  select id
  from public.app_users root_admin
  where root_admin.is_platform_owner = true
  order by root_admin.created_at asc
  limit 1
)
where role = 'admin'
  and is_platform_owner = false
  and owner_admin_id = id
  and created_by_user_id is null;

update public.app_users
set created_by_user_id = owner_admin_id
where role = 'admin'
  and is_platform_owner = false
  and owner_admin_id is not null
  and owner_admin_id <> id
  and created_by_user_id is null;

update public.app_users
set created_by_user_id = owner_admin_id
where role = 'user'
  and owner_admin_id is not null
  and created_by_user_id is null;

alter table public.app_users enable row level security;
alter table public.admin_channel_configs enable row level security;
alter table public.appointments enable row level security;
