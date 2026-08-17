-- ============================================================================
-- T-ERP  |  0023_balances_and_unit_conversions.sql
-- Part 1 — bug fix: customers.balance / suppliers.balance are stored columns
-- that nothing has ever written to since 0001 (every page just displays a
-- permanent 0). Computed views replace them — always correct by
-- construction, no sync code to get wrong, same reasoning used everywhere
-- else in this schema (inventory.on_hand is the one exception, and that one
-- earns its complexity from needing row-level locking for oversell
-- protection; a balance figure has no such requirement).
--
-- Part 2 — unit conversions (spec §12, Aton "разфасовки"): e.g. 1 box = 12
-- pcs. Schema + management UI only in this pass; deep POS/Purchases cart
-- integration (choosing "sell in boxes") is a follow-up, not done here.
-- ============================================================================

create view v_customer_balances
with (security_invoker = true)
as
select
  c.id as customer_id, c.company_id, c.name,
  coalesce(st.total, 0) as total_sales,
  coalesce(pt.total, 0) as total_paid,
  coalesce(st.total, 0) - coalesce(pt.total, 0) as balance
from customers c
left join (
  select customer_id, sum(total) as total
  from sales where status <> 'cancelled' and customer_id is not null
  group by customer_id
) st on st.customer_id = c.id
left join (
  select s.customer_id, sum(p.amount) as total
  from payments p
  join sales s on s.id = p.ref_id and p.ref_table = 'sales'
  where s.customer_id is not null
  group by s.customer_id
) pt on pt.customer_id = c.id;

grant select on v_customer_balances to authenticated;

create view v_supplier_balances
with (security_invoker = true)
as
select
  s.id as supplier_id, s.company_id, s.name,
  coalesce(pt_total.total, 0) as total_purchases,
  coalesce(pay_total.total, 0) as total_paid,
  coalesce(pt_total.total, 0) - coalesce(pay_total.total, 0) as balance
from suppliers s
left join (
  select supplier_id, sum(total) as total
  from purchases where supplier_id is not null
  group by supplier_id
) pt_total on pt_total.supplier_id = s.id
left join (
  select pu.supplier_id, sum(pay.amount) as total
  from payments pay
  join purchases pu on pu.id = pay.ref_id and pay.ref_table = 'purchases'
  where pu.supplier_id is not null
  group by pu.supplier_id
) pay_total on pay_total.supplier_id = s.id;

grant select on v_supplier_balances to authenticated;

-- ----------------------------------------------------------------------------
-- Unit conversions
-- ----------------------------------------------------------------------------

create table unit_conversions (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  from_unit  text not null,   -- 'box'
  to_unit    text not null,   -- 'pcs' — normally the product's base unit
  factor     numeric(18,4) not null check (factor > 0),  -- 1 from_unit = factor * to_unit
  created_at timestamptz not null default now(),
  unique (product_id, from_unit)
);

alter table unit_conversions enable row level security;

create policy unit_conversions_read on unit_conversions for select
  using (product_id in (select id from products where company_id = auth_company_id()));
create policy unit_conversions_write on unit_conversions for insert
  with check (
    has_permission('products', 'edit')
    and product_id in (select id from products where company_id = auth_company_id())
  );
create policy unit_conversions_delete on unit_conversions for delete
  using (
    has_permission('products', 'edit')
    and product_id in (select id from products where company_id = auth_company_id())
  );

-- ----------------------------------------------------------------------------
-- record_payment() — records a payment against an EXISTING sale or purchase
-- (e.g. a supplier invoice paid later on terms, or a customer settling part
-- of their balance). complete_sale()/receive_purchase() handle payment at
-- the moment of the transaction; this is the "pay it off later" path Aton
-- describes as due-date/account tracking. Same reasoning as everywhere else:
-- payments has no direct client write policy, this SECURITY DEFINER
-- function is the only door, and it checks company ownership + permission
-- itself before writing.
-- ----------------------------------------------------------------------------

create or replace function record_payment(
  p_company_id  uuid,
  p_ref_table   text,   -- 'sales' | 'purchases'
  p_ref_id      uuid,
  p_method      payment_method,
  p_amount      numeric,
  p_operator_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('finance', 'edit') then
    raise exception 'FORBIDDEN: missing finance edit permission' using errcode = '42501';
  end if;
  if p_ref_table not in ('sales', 'purchases') then
    raise exception 'INVALID_REF_TABLE';
  end if;

  if p_ref_table = 'sales' then
    if not exists (select 1 from sales where id = p_ref_id and company_id = p_company_id) then
      raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    if not exists (select 1 from purchases where id = p_ref_id and company_id = p_company_id) then
      raise exception 'PURCHASE_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  insert into payments (company_id, ref_table, ref_id, method, amount, operator_id)
  values (p_company_id, p_ref_table, p_ref_id, p_method, p_amount, p_operator_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function record_payment(uuid, text, uuid, payment_method, numeric, uuid) from public;
grant execute on function record_payment(uuid, text, uuid, payment_method, numeric, uuid) to authenticated;
