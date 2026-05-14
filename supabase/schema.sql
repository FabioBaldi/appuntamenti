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
  business_display_name text,
  sms_sender_id text,
  email_mode text not null default 'system' check (email_mode in ('system', 'smtp')),
  email_provider_preset text not null default 'custom',
  email_from_name text,
  email_from_email text,
  email_reply_to text,
  smtp_host text,
  smtp_port integer not null default 587,
  smtp_secure boolean not null default false,
  smtp_username text,
  smtp_password_encrypted text,
  smtp_last_test_status text,
  smtp_last_test_error text,
  smtp_last_test_at timestamptz,
  whatsapp_mode text not null default 'system' check (whatsapp_mode in ('system', 'meta_cloud')),
  meta_access_token_encrypted text,
  meta_phone_number_id text,
  meta_waba_id text,
  meta_business_account_id text,
  meta_display_phone_number text,
  billing_model text not null default 'platform' check (billing_model in ('platform', 'wallet')),
  wallet_balance numeric(12,2) not null default 0,
  wallet_currency text not null default 'EUR',
  sms_unit_price numeric(12,2) not null default 0.08,
  whatsapp_unit_price numeric(12,2) not null default 0.12,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_channel_configs
  add column if not exists business_display_name text;

alter table public.admin_channel_configs
  add column if not exists sms_sender_id text;

alter table public.admin_channel_configs
  add column if not exists email_mode text not null default 'system';

alter table public.admin_channel_configs
  add column if not exists email_provider_preset text not null default 'custom';

alter table public.admin_channel_configs
  add column if not exists email_from_name text;

alter table public.admin_channel_configs
  add column if not exists email_from_email text;

alter table public.admin_channel_configs
  add column if not exists email_reply_to text;

alter table public.admin_channel_configs
  add column if not exists smtp_host text;

alter table public.admin_channel_configs
  add column if not exists smtp_port integer not null default 587;

alter table public.admin_channel_configs
  add column if not exists smtp_secure boolean not null default false;

alter table public.admin_channel_configs
  add column if not exists smtp_username text;

alter table public.admin_channel_configs
  add column if not exists smtp_password_encrypted text;

alter table public.admin_channel_configs
  add column if not exists smtp_last_test_status text;

alter table public.admin_channel_configs
  add column if not exists smtp_last_test_error text;

alter table public.admin_channel_configs
  add column if not exists smtp_last_test_at timestamptz;

alter table public.admin_channel_configs
  add column if not exists billing_model text not null default 'platform';

alter table public.admin_channel_configs
  add column if not exists wallet_balance numeric(12,2) not null default 0;

alter table public.admin_channel_configs
  add column if not exists wallet_currency text not null default 'EUR';

alter table public.admin_channel_configs
  add column if not exists sms_unit_price numeric(12,2) not null default 0.08;

alter table public.admin_channel_configs
  add column if not exists whatsapp_unit_price numeric(12,2) not null default 0.12;

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

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  brand_owner_user_id uuid not null references public.app_users(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  created_by_user_id uuid references public.app_users(id) on delete set null,
  type text not null check (type in ('top_up', 'reminder_debit', 'reminder_refund', 'manual_adjustment')),
  channel text check (channel in ('sms', 'whatsapp')),
  amount_delta numeric(12,2) not null,
  currency text not null default 'EUR',
  description text,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists wallet_transactions_stripe_checkout_session_idx
on public.wallet_transactions (stripe_checkout_session_id)
where stripe_checkout_session_id is not null;

create index if not exists wallet_transactions_brand_owner_idx
on public.wallet_transactions (brand_owner_user_id, created_at desc);

create or replace function public.apply_wallet_transaction(
  p_brand_owner_user_id uuid,
  p_amount_delta numeric,
  p_currency text default 'EUR',
  p_type text default 'manual_adjustment',
  p_channel text default null,
  p_description text default null,
  p_created_by_user_id uuid default null,
  p_appointment_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_stripe_checkout_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_allow_negative boolean default false
)
returns table(wallet_balance numeric, transaction_id uuid, applied boolean)
language plpgsql
as $$
declare
  v_existing_transaction_id uuid;
  v_current_balance numeric(12,2);
  v_new_balance numeric(12,2);
begin
  if p_stripe_checkout_session_id is not null then
    select wt.id
      into v_existing_transaction_id
      from public.wallet_transactions wt
     where wt.stripe_checkout_session_id = p_stripe_checkout_session_id
     limit 1;

    if v_existing_transaction_id is not null then
      select coalesce(acc.wallet_balance, 0)
        into v_current_balance
        from public.admin_channel_configs acc
       where acc.brand_owner_user_id = p_brand_owner_user_id;

      return query
      select coalesce(v_current_balance, 0), v_existing_transaction_id, false;
      return;
    end if;
  end if;

  insert into public.admin_channel_configs (
    brand_owner_user_id,
    wallet_currency,
    billing_model
  )
  values (
    p_brand_owner_user_id,
    coalesce(nullif(upper(trim(coalesce(p_currency, ''))), ''), 'EUR'),
    'wallet'
  )
  on conflict (brand_owner_user_id) do nothing;

  select coalesce(acc.wallet_balance, 0)
    into v_current_balance
    from public.admin_channel_configs acc
   where acc.brand_owner_user_id = p_brand_owner_user_id
   for update;

  v_new_balance := round(v_current_balance + p_amount_delta, 2);

  if not p_allow_negative and v_new_balance < 0 then
    raise exception 'Credito insufficiente nel wallet del ramo';
  end if;

  update public.admin_channel_configs
     set wallet_balance = v_new_balance,
         wallet_currency = coalesce(nullif(upper(trim(coalesce(p_currency, ''))), ''), wallet_currency, 'EUR'),
         updated_at = now()
   where brand_owner_user_id = p_brand_owner_user_id;

  insert into public.wallet_transactions (
    brand_owner_user_id,
    appointment_id,
    created_by_user_id,
    type,
    channel,
    amount_delta,
    currency,
    description,
    stripe_checkout_session_id,
    stripe_payment_intent_id,
    metadata
  )
  values (
    p_brand_owner_user_id,
    p_appointment_id,
    p_created_by_user_id,
    p_type,
    nullif(trim(coalesce(p_channel, '')), ''),
    round(p_amount_delta, 2),
    coalesce(nullif(upper(trim(coalesce(p_currency, ''))), ''), 'EUR'),
    nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_stripe_checkout_session_id, '')), ''),
    nullif(trim(coalesce(p_stripe_payment_intent_id, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_existing_transaction_id;

  return query
  select v_new_balance, v_existing_transaction_id, true;
end;
$$;

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
alter table public.wallet_transactions enable row level security;
alter table public.appointments enable row level security;
