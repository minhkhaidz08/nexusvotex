-- ============================================================
-- Seller role + per-role seller pricing.
-- Paste into Supabase SQL Editor and run. Safe to re-run.
-- ============================================================

-- 1) Allow the 'seller' role on users (replace the old binary CHECK).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'users_role_check' and conrelid = 'public.users'::regclass
  ) then
    alter table public.users drop constraint users_role_check;
  end if;
end $$;

alter table public.users add constraint users_role_check check (role in ('user', 'admin', 'seller'));

-- 2) Products: optional price reserved for seller members.
alter table public.products add column if not exists seller_price numeric(15,2);
