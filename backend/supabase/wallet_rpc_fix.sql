-- NexusVotex: self-healing wallet RPCs (create wallet if missing)
-- Run this in Supabase SQL Editor then retry Admin -> Add money.

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


