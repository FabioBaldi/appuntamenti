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

alter table public.wallet_transactions enable row level security;
