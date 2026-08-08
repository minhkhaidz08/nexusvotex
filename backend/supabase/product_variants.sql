-- ============================================================
-- NexusVotex - Product variants (loại key: giờ/ngày/vip/pro...)
-- Run this in the Supabase SQL Editor. Idempotent - safe to re-run.
-- ============================================================

-- Variant definitions, one per product. Each variant carries its own
-- price and seller_price so a single product can sell several key tiers.
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

-- Keys belong to a variant so stock is tracked per variant.
alter table public.inventory_keys add column if not exists variant_id uuid references public.product_variants(id) on delete cascade;
create index if not exists idx_inventory_variant on public.inventory_keys (product_id, variant_id, is_sold) where is_sold = false;

-- Orders snapshot the variant that was purchased.
alter table public.orders add column if not exists variant_id uuid;
alter table public.orders add column if not exists variant_name text;

alter table public.custom_orders add column if not exists variant_id uuid;
alter table public.custom_orders add column if not exists variant_name text;

-- Backfill: every existing product gets a default variant named after its
-- own price, so the mandatory-variant rule holds for legacy data.
insert into public.product_variants (product_id, name, price, seller_price, sort_order)
select id, 'Mặc định', price, seller_price, 0
from public.products p
where not exists (select 1 from public.product_variants pv where pv.product_id = p.id);

-- Existing keys move under their product's default variant.
update public.inventory_keys k
set variant_id = (
  select pv.id from public.product_variants pv
  where pv.product_id = k.product_id
  order by pv.sort_order, pv.created_at
  limit 1
)
where k.variant_id is null;
