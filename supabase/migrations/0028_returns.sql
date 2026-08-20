-- ============================================================================
-- T-ERP  |  0028_returns.sql
-- Returns as a first-class flow (spec §61). Voiding a sale (0009) undoes an
-- entire sale; this is for partial, after-the-fact returns of specific
-- items — with a resellable/damaged distinction (resellable stock goes back
-- into inventory via apply_stock_movement 'return_in'; damaged stock is
-- accepted back physically but does NOT re-enter sellable inventory).
-- Also extends the balance views from 0023 so returns correctly reduce what
-- a customer owes / what we owe a supplier, without touching the payments
-- table's sign convention (payments always stay positive = money that
-- actually moved).
-- ============================================================================

create table customer_returns (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  sale_id      uuid references sales(id),
  customer_id  uuid references customers(id),
  warehouse_id uuid not null references warehouses(id),
  operator_id  uuid references app_users(id),
  reason       text,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table customer_return_items (
  id         uuid primary key default gen_random_uuid(),
  return_id  uuid not null references customer_returns(id) on delete cascade,
  variant_id uuid not null references product_variants(id),
  quantity   numeric(18,3) not null check (quantity > 0),
  unit_price numeric(18,4) not null,
  condition  text not null default 'resellable' check (condition in ('resellable', 'damaged'))
);

create table supplier_returns (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  purchase_id  uuid references purchases(id),
  supplier_id  uuid references suppliers(id),
  warehouse_id uuid not null references warehouses(id),
  operator_id  uuid references app_users(id),
  reason       text,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table supplier_return_items (
  id         uuid primary key default gen_random_uuid(),
  return_id  uuid not null references supplier_returns(id) on delete cascade,
  variant_id uuid not null references product_variants(id),
  quantity   numeric(18,3) not null check (quantity > 0),
  unit_cost  numeric(18,4) not null
);

alter table customer_returns enable row level security;
alter table customer_return_items enable row level security;
alter table supplier_returns enable row level security;
alter table supplier_return_items enable row level security;

create policy customer_returns_read on customer_returns for select using (company_id = auth_company_id());
create policy customer_return_items_read on customer_return_items for select
  using (return_id in (select id from customer_returns where company_id = auth_company_id()));
create policy supplier_returns_read on supplier_returns for select using (company_id = auth_company_id());
create policy supplier_return_items_read on supplier_return_items for select
  using (return_id in (select id from supplier_returns where company_id = auth_company_id()));

create view v_customer_returns_list
with (security_invoker = true)
as
select
  cr.id, cr.company_id, cr.document_no, cr.reason, cr.created_at,
  c.name as customer_name, w.name as warehouse_name, u.full_name as operator_name,
  (select coalesce(sum(quantity * unit_price), 0) from customer_return_items i where i.return_id = cr.id) as total_value
from customer_returns cr
left join customers c on c.id = cr.customer_id
join warehouses w on w.id = cr.warehouse_id
left join app_users u on u.id = cr.operator_id;

grant select on v_customer_returns_list to authenticated;

create view v_supplier_returns_list
with (security_invoker = true)
as
select
  sr.id, sr.company_id, sr.document_no, sr.reason, sr.created_at,
  s.name as supplier_name, w.name as warehouse_name, u.full_name as operator_name,
  (select coalesce(sum(quantity * unit_cost), 0) from supplier_return_items i where i.return_id = sr.id) as total_value
from supplier_returns sr
left join suppliers s on s.id = sr.supplier_id
join warehouses w on w.id = sr.warehouse_id
left join app_users u on u.id = sr.operator_id;

grant select on v_supplier_returns_list to authenticated;

-- ----------------------------------------------------------------------------
-- create_customer_return() — resellable items go back into inventory;
-- damaged items are logged (received back physically) but stay out of
-- sellable stock, matching real accounting practice.
-- ----------------------------------------------------------------------------

create or replace function create_customer_return(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_customer_id  uuid,
  p_sale_id      uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_reason       text,
  p_items        jsonb   -- [{variant_id, quantity, unit_price, condition}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_return_id uuid;
  v_item      jsonb;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('sales', 'edit') then
    raise exception 'FORBIDDEN: missing sales edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into customer_returns (company_id, document_no, sale_id, customer_id, warehouse_id, operator_id, reason)
  values (p_company_id, p_document_no, p_sale_id, p_customer_id, p_warehouse_id, p_operator_id, p_reason)
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into customer_return_items (return_id, variant_id, quantity, unit_price, condition)
    values (
      v_return_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric, coalesce(v_item->>'condition', 'resellable')
    );

    if coalesce(v_item->>'condition', 'resellable') = 'resellable' then
      perform apply_stock_movement(
        p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
        'return_in', (v_item->>'quantity')::numeric,
        'customer_returns', v_return_id, p_operator_id, 'Customer return - resellable'
      );
    end if;
  end loop;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (p_operator_id, 'CUSTOMER_RETURN_CREATED', 'customer_returns', v_return_id::text,
          jsonb_build_object('document_no', p_document_no, 'reason', p_reason));

  return v_return_id;
end;
$$;

revoke all on function create_customer_return(uuid, uuid, uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function create_customer_return(uuid, uuid, uuid, uuid, uuid, text, text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- create_supplier_return() — always decrements stock (goods physically
-- leave, going back to the supplier).
-- ----------------------------------------------------------------------------

create or replace function create_supplier_return(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_supplier_id  uuid,
  p_purchase_id  uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_reason       text,
  p_items        jsonb   -- [{variant_id, quantity, unit_cost}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_return_id uuid;
  v_item      jsonb;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('purchases', 'edit') then
    raise exception 'FORBIDDEN: missing purchases edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into supplier_returns (company_id, document_no, purchase_id, supplier_id, warehouse_id, operator_id, reason)
  values (p_company_id, p_document_no, p_purchase_id, p_supplier_id, p_warehouse_id, p_operator_id, p_reason)
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into supplier_return_items (return_id, variant_id, quantity, unit_cost)
    values (v_return_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric);

    perform apply_stock_movement(
      p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
      'return_out', -(v_item->>'quantity')::numeric,
      'supplier_returns', v_return_id, p_operator_id, 'Supplier return'
    );
  end loop;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (p_operator_id, 'SUPPLIER_RETURN_CREATED', 'supplier_returns', v_return_id::text,
          jsonb_build_object('document_no', p_document_no, 'reason', p_reason));

  return v_return_id;
end;
$$;

revoke all on function create_supplier_return(uuid, uuid, uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function create_supplier_return(uuid, uuid, uuid, uuid, uuid, text, text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- Extend the balance views from 0023 to account for returns. A customer
-- return reduces what they owe (whether or not the goods were resellable —
-- the customer still gets credited); a supplier return reduces what we owe
-- the supplier.
-- ----------------------------------------------------------------------------

create or replace view v_customer_balances
with (security_invoker = true)
as
select
  c.id as customer_id, c.company_id, c.name,
  coalesce(st.total, 0) as total_sales,
  coalesce(pt.total, 0) as total_paid,
  coalesce(st.total, 0) - coalesce(pt.total, 0) - coalesce(rt.total, 0) as balance,
  coalesce(rt.total, 0) as total_returned
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
) pt on pt.customer_id = c.id
left join (
  select cr.customer_id, sum(cri.quantity * cri.unit_price) as total
  from customer_return_items cri
  join customer_returns cr on cr.id = cri.return_id
  where cr.customer_id is not null
  group by cr.customer_id
) rt on rt.customer_id = c.id;

grant select on v_customer_balances to authenticated;

create or replace view v_supplier_balances
with (security_invoker = true)
as
select
  s.id as supplier_id, s.company_id, s.name,
  coalesce(pt_total.total, 0) as total_purchases,
  coalesce(pay_total.total, 0) as total_paid,
  coalesce(pt_total.total, 0) - coalesce(pay_total.total, 0) - coalesce(rt_total.total, 0) as balance,
  coalesce(rt_total.total, 0) as total_returned
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
) pay_total on pay_total.supplier_id = s.id
left join (
  select sr.supplier_id, sum(sri.quantity * sri.unit_cost) as total
  from supplier_return_items sri
  join supplier_returns sr on sr.id = sri.return_id
  where sr.supplier_id is not null
  group by sr.supplier_id
) rt_total on rt_total.supplier_id = s.id;

grant select on v_supplier_balances to authenticated;
