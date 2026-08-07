-- ============================================================
-- NexusVotex - Convert custom_orders from "custom order by request"
-- (uid/character/server) to "pre-order for keys" (qty + key fill
-- by admin). Paste into Supabase SQL Editor and run.
-- Safe to re-run.
-- ============================================================

-- Add quantity (how many keys the customer pre-ordered)
alter table public.custom_orders add column if not exists qty int not null default 1;

-- uid / character_name / server are no longer customer inputs
alter table public.custom_orders alter column uid drop not null;
alter table public.custom_orders alter column character_name drop not null;
alter table public.custom_orders alter column server drop not null;
