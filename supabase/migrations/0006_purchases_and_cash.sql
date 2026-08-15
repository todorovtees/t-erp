-- ============================================================================
-- T-ERP  |  0006_purchases_and_cash.sql
-- Write policies for cash registers/sessions (simple state, no atomicity
-- concern) + an atomic receive_purchase() RPC mirroring complete_sale(),
-- since receiving stock needs the same permission/company checks as selling
-- it, even though the row-lock danger (overselling) doesn't apply here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Cash registers/sessions — direct writes are fine here (no oversell-style
--    race to protect against), just gate by has_permission('finance','edit').
-- ----------------------------------------------------------------------------

create policy cash_registers_write on cash_registers for insert
  with check (company_id = auth_company_id() and has_permission('finance','edit'));
create policy cash_registers_update on cash_registers for update
  using (company_id = auth_company_id() and has_permission('finance','edit'));

create policy cash_sessions_read on cash_sessions for select
  using (cash_register_id in (select id from cash_registers where company_id = auth_company_id()));
create policy cash_sessions_write on cash_sessions for insert
  with check (
    has_permission('finance','edit')
    and cash_register_id in (select id from cash_registers where company_id = auth_company_id())
    and operator_id = auth.uid()
  );
create policy cash_sessions_update on cash_sessions for update
  using (
    has_permission('finance','edit')
    and cash_register_id in (select id from cash_registers where company_id = auth_company_id())
  );

-- ----------------------------------------------------------------------------
-- 2. receive_purchase() — creates a purchase + purchase_items, adds stock via
--    apply_stock_movement (type 'purchase_receipt', positive quantity).
--    SECURITY DEFINER for the same reason as complete_sale: direct writes to
--    purchases/purchase_items/inventory stay blocked for clients, this RPC
--    is the only door, and it checks permission + company ownership itself.
-- ----------------------------------------------------------------------------

create or replace function receive_purchase(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_supplier_id  uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_items        jsonb   -- [{variant_id, quantity, unit_cost}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase_id uuid;
  v_item        jsonb;
  v_total       numeric(18,2) := 0;
  v_line        numeric(18,2);
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('purchases','edit') then
    raise exception 'FORBIDDEN: missing purchases edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into purchases (company_id, document_no, warehouse_id, supplier_id, operator_id, status)
  values (p_company_id, p_document_no, p_warehouse_id, p_supplier_id, p_operator_id, 'received')
  returning id into v_purchase_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := (v_item->>'quantity')::numeric * (v_item->>'unit_cost')::numeric;

    insert into purchase_items (purchase_id, variant_id, quantity, unit_cost, line_total)
    values (
      v_purchase_id, (v_item->>'variant_id')::uuid,
      (v_item->>'quantity')::numeric, (v_item->>'unit_cost')::numeric, v_line
    );

    perform apply_stock_movement(
      p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
      'purchase_receipt', (v_item->>'quantity')::numeric,
      'purchases', v_purchase_id, p_operator_id, null
    );

    v_total := v_total + v_line;
  end loop;

  update purchases set total = v_total where id = v_purchase_id;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (p_operator_id, 'PURCHASE_RECEIVED', 'purchases', v_purchase_id::text,
          jsonb_build_object('total', v_total, 'document_no', p_document_no));

  return v_purchase_id;
end;
$$;

revoke all on function receive_purchase(uuid,uuid,uuid,uuid,text,jsonb) from public;
grant execute on function receive_purchase(uuid,uuid,uuid,uuid,text,jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Flat list views for the Sales / Purchases pages (customer/supplier name
--    + item count in one query, same reasoning as v_product_summary).
-- ----------------------------------------------------------------------------

create view v_sales_list
with (security_invoker = true)
as
select
  s.id, s.company_id, s.document_no, s.status, s.channel, s.total, s.currency, s.created_at,
  c.name as customer_name,
  w.name as warehouse_name,
  u.full_name as operator_name,
  (select count(*) from sale_items si where si.sale_id = s.id) as item_count
from sales s
left join customers c on c.id = s.customer_id
join warehouses w on w.id = s.warehouse_id
left join app_users u on u.id = s.operator_id;

grant select on v_sales_list to authenticated;

create view v_purchases_list
with (security_invoker = true)
as
select
  p.id, p.company_id, p.document_no, p.status, p.total, p.currency, p.created_at,
  s.name as supplier_name,
  w.name as warehouse_name,
  u.full_name as operator_name,
  (select count(*) from purchase_items pi where pi.purchase_id = p.id) as item_count
from purchases p
left join suppliers s on s.id = p.supplier_id
join warehouses w on w.id = p.warehouse_id
left join app_users u on u.id = p.operator_id;

grant select on v_purchases_list to authenticated;
