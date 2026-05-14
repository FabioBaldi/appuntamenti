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
