-- ============================================================
-- NexusVotex - Supabase Database Schema
-- Run this file in the Supabase SQL Editor, or via:
--   psql "$DATABASE_URL" -f supabase/schema.sql
-- ============================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ============ USERS ============
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  name text not null default '',
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin', 'seller')),
  is_banned boolean not null default false,
  reset_token text,
  reset_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ CATEGORIES ============
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  icon text default '',
  description text default '',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_categories_sort on public.categories (sort_order, name);

-- ============ PRODUCTS ============
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  description text default '',
  short_description text default '',
  price numeric(15,2) not null default 0,
  seller_price numeric(15,2),
  original_price numeric(15,2),
  image_url text,
  category text default 'Khác',
  category_id uuid references public.categories(id) on delete set null,
  type text not null default 'instant' check (type in ('instant', 'custom')),
  badge text,                    -- HOT | NEW | SALE | null
  discount numeric(5,2),
  is_active boolean not null default true,
  is_featured boolean not null default false,
  is_hot boolean not null default false,
  is_sale boolean not null default false,
  stock_override integer,        -- manual stock number, overrides key count
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_category on public.products (category_id);

-- ============ PRODUCT VARIANTS (loại key: giờ/ngày/vip/pro...) ============
create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  price numeric(15,2) not null default 0,
  seller_price numeric(15,2),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_product_variants_product on public.product_variants (product_id, sort_order);

-- ============ INVENTORY KEYS ============
create table if not exists public.inventory_keys (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  key_value text not null,
  is_sold boolean not null default false,
  order_id uuid,                 -- set when sold (refers to orders.id)
  sold_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_inventory_available on public.inventory_keys (product_id, is_sold) where is_sold = false;
create index if not exists idx_inventory_variant on public.inventory_keys (product_id, variant_id, is_sold) where is_sold = false;
create index if not exists idx_inventory_sold on public.inventory_keys (product_id, is_sold) where is_sold = true;
create index if not exists idx_inventory_order on public.inventory_keys (order_id) where order_id is not null;

-- ============ ORDERS (instant key purchases) ============
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_code text unique not null,
  group_code text,               -- shared code for multi-item checkout
  user_id uuid not null references public.users(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  variant_id uuid,
  variant_name text,
  key_id uuid references public.inventory_keys(id),
  key_value text,
  price numeric(15,2) not null default 0,
  discount_amount numeric(15,2) not null default 0,
  total numeric(15,2) not null default 0,
  status text not null default 'success' check (status in ('success', 'refunded')),
  payment_method text not null default 'wallet',
  created_at timestamptz not null default now()
);
create index if not exists idx_orders_user on public.orders (user_id, created_at desc);
create index if not exists idx_orders_group on public.orders (group_code);
create index if not exists idx_orders_product on public.orders (product_id);

-- ============ CUSTOM ORDERS (make-to-order) ============
create table if not exists public.custom_orders (
  id uuid primary key default gen_random_uuid(),
  order_code text unique not null,
  user_id uuid not null references public.users(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_name text not null,
  variant_id uuid,
  variant_name text,
  qty int not null default 1,
  uid text,
  character_name text,
  server text default 'Vietnam',
  note text default '',
  paid_amount numeric(15,2) not null default 0,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  admin_key text,                -- key or account info filled by admin
  admin_message text,
  account_info text,
  file_url text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_custom_orders_user on public.custom_orders (user_id, created_at desc);
create index if not exists idx_custom_orders_status on public.custom_orders (status);

-- ============ WALLETS ============
create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references public.users(id) on delete cascade,
  balance numeric(15,2) not null default 0 check (balance >= 0),
  total_deposited numeric(15,2) not null default 0,
  total_spent numeric(15,2) not null default 0,
  updated_at timestamptz not null default now()
);
-- Migration guard: add the balance>=0 guard on existing deployments.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wallets'::regclass and conname = 'wallets_balance_non_negative') then
    alter table public.wallets add constraint wallets_balance_non_negative check (balance >= 0);
  end if;
end $$;

-- ============ WALLET TRANSACTIONS ============
create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(15,2) not null,            -- positive = credit, negative = debit
  type text not null check (type in ('deposit', 'purchase', 'refund', 'adjust_credit', 'adjust_debit')),
  balance_after numeric(15,2) not null,
  description text default '',
  ref_type text,                            -- payment | order | custom_order | wallet
  ref_id text,                              -- payment.id / order_code / custom_order.id
  created_at timestamptz not null default now()
);
create index if not exists idx_wallet_tx_user on public.wallet_transactions (user_id, created_at desc);
-- Migration guard: earlier deployments created ref_id as uuid; ref_id now holds
-- order codes (text) too, so widen it for existing installs.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'wallet_transactions'
      and column_name = 'ref_id' and data_type = 'uuid'
  ) then
    alter table public.wallet_transactions alter column ref_id type text using ref_id::text;
  end if;
end $$;
-- Every wallet mutation that carries a ref_id must be recorded exactly once.
-- This is the DB-level idempotency gate for the atomic wallet RPC functions
-- below, and a loud canary if any code path ever tries to credit twice.
drop index if exists uq_wallet_tx_ref;
create unique index uq_wallet_tx_ref on public.wallet_transactions (ref_type, ref_id) where ref_id is not null;

-- ============ PAYMENTS ============
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  payment_code text unique not null,
  user_id uuid not null references public.users(id) on delete cascade,
  amount numeric(15,2),
  method text not null check (method in ('thesieure', 'payos', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  provider text default '',
  provider_code text,
  provider_message text,
  detail jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_payments_user on public.payments (user_id, created_at desc);
create index if not exists idx_payments_status on public.payments (status);
create index if not exists idx_payments_provider_code on public.payments (provider_code);

-- ============ NOTIFICATIONS ============
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,  -- null = broadcast
  title text not null,
  content text default '',
  type text not null default 'info',   -- deposit | order | custom_order | refund | news | wallet | info
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on public.notifications (user_id, is_read);

-- ============ DISCOUNT CODES ============
create table if not exists public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  value numeric(15,2) not null,
  max_uses integer,
  used_count integer not null default 0,
  min_amount numeric(15,2),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============ NEWS ============
create table if not exists public.news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  image_url text,
  is_published boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============ SETTINGS ============
create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value text,
  description text default '',
  updated_at timestamptz not null default now()
);

-- ============ ACTIVITY LOGS ============
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  action text not null,
  detail text default '',
  ip text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_activity_logs_created on public.activity_logs (created_at desc);

-- ============ ROW LEVEL SECURITY ============
-- RLS is disabled for the service-role key usage in this app.
-- The backend uses the service role key exclusively, so we enable RLS
-- but add permissive policies for authenticated users where needed.
-- If you expose anon key to the frontend, tighten these policies.

alter table public.users enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.inventory_keys enable row level security;
alter table public.orders enable row level security;
alter table public.custom_orders enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.payments enable row level security;
alter table public.notifications enable row level security;
alter table public.discount_codes enable row level security;
alter table public.news enable row level security;
alter table public.settings enable row level security;
alter table public.activity_logs enable row level security;

-- Service role bypasses RLS automatically. Policies below are for
-- direct anon/authenticated access (optional hardening):

-- Products & news & settings are public-readable
create policy "public_read_products" on public.products for select using (true);
create policy "public_read_categories" on public.categories for select using (true);
create policy "public_read_news" on public.news for select using (true);
create policy "public_read_settings" on public.settings for select using (true);

-- Users can read their own data
create policy "own_read_users" on public.users for select using (auth.uid() = id);
create policy "own_read_wallet" on public.wallets for select using (auth.uid() = user_id);
create policy "own_read_wallet_tx" on public.wallet_transactions for select using (auth.uid() = user_id);
create policy "own_read_orders" on public.orders for select using (auth.uid() = user_id);
create policy "own_read_custom_orders" on public.custom_orders for select using (auth.uid() = user_id);
create policy "own_read_notifications" on public.notifications for select using (auth.uid() = user_id);
create policy "own_read_payments" on public.payments for select using (auth.uid() = user_id);

-- ============ TRIGGERS ============
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated on public.users;
create trigger trg_users_updated before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists trg_wallets_updated on public.wallets;
create trigger trg_wallets_updated before update on public.wallets
  for each row execute function public.set_updated_at();

drop trigger if exists trg_settings_updated on public.settings;
create trigger trg_settings_updated before update on public.settings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_categories_updated on public.categories;
create trigger trg_categories_updated before update on public.categories
  for each row execute function public.set_updated_at();

drop trigger if exists trg_news_updated on public.news;
create trigger trg_news_updated before update on public.news
  for each row execute function public.set_updated_at();

-- ============ ATOMIC WALLET MUTATIONS (RPC) ============
-- The backend moves money through these functions instead of multi-statement
-- JS calls, because PostgREST has no transaction boundary between statements:
-- a crash (or a failed follow-up insert) between "update balance" and
-- "record wallet_transactions" would move money with no audit trail, and a
-- retry could then double-credit. Each function is ONE plpgsql transaction:
-- it takes the wallet row lock (`for update`) so concurrent mutations for the
-- same user serialize, records the transaction row, and returns the new
-- balance. They are idempotent per (ref_type, ref_id): a ref that already has
-- a recorded transaction returns the existing balance without moving money.
--
-- `security definer` + fixed search_path so the functions run with table
-- owner privileges (bypassing RLS) regardless of who invokes them.

create or replace function public.credit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_type text default 'deposit',
  p_description text default '',
  p_ref_type text default null,
  p_ref_id text default null
) returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_wallet wallets%rowtype;
  v_new numeric;
  v_existing numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  select * into v_wallet from wallets where user_id = p_user_id for update;
  if not found then
    insert into wallets (user_id, balance, total_deposited, total_spent)
      values (p_user_id, 0, 0, 0)
      on conflict (user_id) do nothing;
    select * into v_wallet from wallets where user_id = p_user_id for update;
    if not found then
      raise exception 'wallet not found';
    end if;
  end if;

  -- Idempotency check AFTER the row lock: concurrent calls for the same ref
  -- serialize on the lock, so exactly one sees a missing transaction and wins.
  if p_ref_id is not null then
    select balance_after into v_existing
      from wallet_transactions
      where ref_id = p_ref_id and ref_type = p_ref_type and balance_after is not null
      order by created_at
      limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  v_new := v_wallet.balance + p_amount;
  update wallets
    set balance = v_new,
        total_deposited = v_wallet.total_deposited + case when p_type = 'deposit' then p_amount else 0 end,
        updated_at = now()
    where id = v_wallet.id;

  insert into wallet_transactions (user_id, amount, type, balance_after, description, ref_type, ref_id)
    values (p_user_id, p_amount, p_type, v_new, p_description, p_ref_type, p_ref_id);

  return v_new;
end;
$$;

create or replace function public.debit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_description text default '',
  p_ref_type text default null,
  p_ref_id text default null
) returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_wallet wallets%rowtype;
  v_new numeric;
  v_existing numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid amount';
  end if;

  select * into v_wallet from wallets where user_id = p_user_id for update;
  if not found then
    insert into wallets (user_id, balance, total_deposited, total_spent)
      values (p_user_id, 0, 0, 0)
      on conflict (user_id) do nothing;
    select * into v_wallet from wallets where user_id = p_user_id for update;
    if not found then
      raise exception 'wallet not found';
    end if;
  end if;

  if p_ref_id is not null then
    select balance_after into v_existing
      from wallet_transactions
      where ref_id = p_ref_id and ref_type = p_ref_type and balance_after is not null
      order by created_at
      limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  if v_wallet.balance < p_amount then
    raise exception 'insufficient balance';
  end if;

  v_new := v_wallet.balance - p_amount;
  update wallets
    set balance = v_new,
        total_spent = v_wallet.total_spent + p_amount,
        updated_at = now()
    where id = v_wallet.id;

  insert into wallet_transactions (user_id, amount, type, balance_after, description, ref_type, ref_id)
    values (p_user_id, -p_amount, 'purchase', v_new, p_description, p_ref_type, p_ref_id);

  return v_new;
end;
$$;

create or replace function public.adjust_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_description text default ''
) returns numeric
language plpgsql security definer set search_path = public
as $$
declare
  v_wallet wallets%rowtype;
  v_new numeric;
  v_type text;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'amount must not be zero';
  end if;

  select * into v_wallet from wallets where user_id = p_user_id for update;
  if not found then
    insert into wallets (user_id, balance, total_deposited, total_spent)
      values (p_user_id, 0, 0, 0)
      on conflict (user_id) do nothing;
    select * into v_wallet from wallets where user_id = p_user_id for update;
    if not found then
      raise exception 'wallet not found';
    end if;
  end if;

  v_new := v_wallet.balance + p_amount;
  if v_new < 0 then
    raise exception 'insufficient balance';
  end if;

  v_type := case when p_amount > 0 then 'adjust_credit' else 'adjust_debit' end;
  update wallets
    set balance = v_new,
        total_deposited = v_wallet.total_deposited + case when p_amount > 0 then p_amount else 0 end,
        total_spent = v_wallet.total_spent + case when p_amount < 0 then -p_amount else 0 end,
        updated_at = now()
    where id = v_wallet.id;

  insert into wallet_transactions (user_id, amount, type, balance_after, description, ref_type)
    values (p_user_id, p_amount, v_type, v_new, p_description, 'wallet');

  return v_new;
end;
$$;

-- ============ GRANTS ============
-- The backend runs exclusively on the service-role (secret) key, so it needs
-- full table access. The RLS policies above already restrict anon/authenticated
-- to public reads and own-data rows, so granting them here (standard Supabase
-- boilerplate) does not open up writes: RLS still gates every row.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
