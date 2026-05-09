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

drop trigger if exists trg_admin_channel_configs_updated_at on public.admin_channel_configs;
create trigger trg_admin_channel_configs_updated_at
before update on public.admin_channel_configs
for each row
execute function public.set_updated_at();

alter table public.admin_channel_configs enable row level security;
