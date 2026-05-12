alter table public.admin_channel_configs
  add column if not exists business_display_name text;

alter table public.admin_channel_configs
  add column if not exists sms_sender_id text;

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
