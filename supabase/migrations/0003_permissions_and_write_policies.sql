-- ============================================================================
-- T-ERP  |  0003_permissions_and_write_policies.sql
-- Closes the gap left by 0001/0002 (which only added READ policies).
-- Pattern used everywhere below:
--   - Simple reference data (products, warehouses, customers...) gets
--     per-table RLS INSERT/UPDATE/DELETE policies gated by has_permission().
--   - Money/stock-moving logic (apply_stock_movement, complete_sale) is
--     funnelled through SECURITY DEFINER functions that do their own
--     authorization + company-ownership checks, and direct table writes to
--     inventory/sales/purchases/stock_movements/payments stay unreachable
--     from the client (RLS enabled, no INSERT/UPDATE policy = denied).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. role_permissions was missed by 0001 — lock it down now.
-- ----------------------------------------------------------------------------

alter table role_permissions enable row level security;

create policy role_permissions_read on role_permissions for select using (true);
-- No INSERT/UPDATE/DELETE policy on purpose: changes ship via migration or a
-- future dedicated "manage roles" RPC restricted to super_admin, not raw
-- client writes.

-- ----------------------------------------------------------------------------
-- 2. has_permission() — single source of truth for "can this user do X".
--    SECURITY DEFINER so it can read app_users/role_permissions regardless
--    of the caller's own RLS visibility.
-- ----------------------------------------------------------------------------

create or replace function has_permission(p_module text, p_min permission_level)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from app_users u
    join role_permissions rp on rp.role = u.role and rp.module = p_module
    where u.id = auth.uid()
      and u.status = 'active'
      and (
        p_min = 'view' and rp.level in ('view','edit','full')
        or p_min = 'edit' and rp.level in ('edit','full')
        or p_min = 'full' and rp.level = 'full'
      )
  );
$$;

revoke all on function has_permission(text, permission_level) from public;
grant execute on function has_permission(text, permission_level) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. DEFAULT ROLE PERMISSIONS  (matches the examples in the spec, §39)
--    Editable later from Settings → Roles once that UI exists — for now this
--    is the seed of record.
-- ----------------------------------------------------------------------------

insert into role_permissions (role, module, level, can_approve, can_export, can_print) values
  -- super_admin & admin: full everywhere
  ('super_admin','products','full',true,true,true), ('admin','products','full',true,true,true),
  ('super_admin','inventory','full',true,true,true), ('admin','inventory','full',true,true,true),
  ('super_admin','warehouses','full',true,true,true), ('admin','warehouses','full',true,true,true),
  ('super_admin','sales','full',true,true,true), ('admin','sales','full',true,true,true),
  ('super_admin','purchases','full',true,true,true), ('admin','purchases','full',true,true,true),
  ('super_admin','customers','full',true,true,true), ('admin','customers','full',true,true,true),
  ('super_admin','suppliers','full',true,true,true), ('admin','suppliers','full',true,true,true),
  ('super_admin','finance','full',true,true,true), ('admin','finance','full',true,true,true),
  ('super_admin','reports','full',true,true,true), ('admin','reports','full',true,true,true),
  ('super_admin','users','full',true,true,true), ('admin','users','full',true,true,true),
  ('super_admin','settings','full',true,true,true), ('admin','settings','full',true,true,true),

  -- manager: full on operations, view on finance/users/settings
  ('manager','products','full',true,true,true), ('manager','inventory','full',true,true,true),
  ('manager','warehouses','full',false,true,true), ('manager','sales','full',true,true,true),
  ('manager','purchases','full',true,true,true), ('manager','customers','full',false,true,true),
  ('manager','suppliers','full',false,true,true), ('manager','finance','view',false,true,false),
  ('manager','reports','full',false,true,true), ('manager','users','view',false,false,false),
  ('manager','settings','view',false,false,false),

  -- warehouse_operator: per spec example — products view, inventory edit, sales view, finance none
  ('warehouse_operator','products','view',false,false,true),
  ('warehouse_operator','inventory','edit',false,true,true),
  ('warehouse_operator','warehouses','view',false,false,false),
  ('warehouse_operator','sales','view',false,false,false),
  ('warehouse_operator','purchases','edit',false,false,true),
  ('warehouse_operator','customers','none',false,false,false),
  ('warehouse_operator','suppliers','view',false,false,false),
  ('warehouse_operator','finance','none',false,false,false),
  ('warehouse_operator','reports','view',false,false,false),
  ('warehouse_operator','users','none',false,false,false),
  ('warehouse_operator','settings','none',false,false,false),

  -- sales_operator
  ('sales_operator','products','view',false,false,true),
  ('sales_operator','inventory','view',false,false,false),
  ('sales_operator','warehouses','view',false,false,false),
  ('sales_operator','sales','edit',false,true,true),
  ('sales_operator','purchases','none',false,false,false),
  ('sales_operator','customers','edit',false,true,false),
  ('sales_operator','suppliers','none',false,false,false),
  ('sales_operator','finance','none',false,false,false),
  ('sales_operator','reports','view',false,true,false),
  ('sales_operator','users','none',false,false,false),
  ('sales_operator','settings','none',false,false,false),

  -- cashier: POS-focused
  ('cashier','products','view',false,false,false),
  ('cashier','inventory','view',false,false,false),
  ('cashier','warehouses','view',false,false,false),
  ('cashier','sales','edit',false,false,true),
  ('cashier','purchases','none',false,false,false),
  ('cashier','customers','view',false,false,false),
  ('cashier','suppliers','none',false,false,false),
  ('cashier','finance','view',false,false,true),
  ('cashier','reports','none',false,false,false),
  ('cashier','users','none',false,false,false),
  ('cashier','settings','none',false,false,false),

  -- accountant: per spec example — finance full, inventory view, sales view
  ('accountant','products','view',false,true,false),
  ('accountant','inventory','view',false,true,false),
  ('accountant','warehouses','view',false,false,false),
  ('accountant','sales','view',false,true,true),
  ('accountant','purchases','view',false,true,true),
  ('accountant','customers','view',false,true,false),
  ('accountant','suppliers','view',false,true,false),
  ('accountant','finance','full',true,true,true),
  ('accountant','reports','full',false,true,true),
  ('accountant','users','none',false,false,false),
  ('accountant','settings','none',false,false,false),

  -- read_only: view everywhere, nothing else
  ('read_only','products','view',false,false,false), ('read_only','inventory','view',false,false,false),
  ('read_only','warehouses','view',false,false,false), ('read_only','sales','view',false,false,false),
  ('read_only','purchases','view',false,false,false), ('read_only','customers','view',false,false,false),
  ('read_only','suppliers','view',false,false,false), ('read_only','finance','view',false,false,false),
  ('read_only','reports','view',false,false,false), ('read_only','users','none',false,false,false),
  ('read_only','settings','none',false,false,false)
on conflict (role, module) do nothing;

-- ----------------------------------------------------------------------------
-- 4. WRITE POLICIES — simple reference-data tables
-- ----------------------------------------------------------------------------

create policy products_write on products for insert
  with check (company_id = auth_company_id() and has_permission('products','edit'));
create policy products_update on products for update
  using (company_id = auth_company_id() and has_permission('products','edit'));
create policy products_delete on products for delete
  using (company_id = auth_company_id() and has_permission('products','full'));

create policy variants_write on product_variants for insert
  with check (
    has_permission('products','edit')
    and product_id in (select id from products where company_id = auth_company_id())
  );
create policy variants_update on product_variants for update
  using (
    has_permission('products','edit')
    and product_id in (select id from products where company_id = auth_company_id())
  );

create policy barcodes_write on barcodes for insert
  with check (
    has_permission('products','edit')
    and variant_id in (
      select v.id from product_variants v
      join products p on p.id = v.product_id
      where p.company_id = auth_company_id()
    )
  );

create policy categories_write on categories for insert
  with check (company_id = auth_company_id() and has_permission('products','edit'));
create policy brands_write on brands for insert
  with check (company_id = auth_company_id() and has_permission('products','edit'));

create policy warehouses_write on warehouses for insert
  with check (company_id = auth_company_id() and has_permission('warehouses','edit'));
create policy warehouses_update on warehouses for update
  using (company_id = auth_company_id() and has_permission('warehouses','edit'));

create policy customers_write on customers for insert
  with check (company_id = auth_company_id() and has_permission('customers','edit'));
create policy customers_update on customers for update
  using (company_id = auth_company_id() and has_permission('customers','edit'));

create policy suppliers_write on suppliers for insert
  with check (company_id = auth_company_id() and has_permission('suppliers','edit'));
create policy suppliers_update on suppliers for update
  using (company_id = auth_company_id() and has_permission('suppliers','edit'));

-- ----------------------------------------------------------------------------
-- 5. AUDIT LOG — tighten the overly-broad policy from 0001.
--    A row can only be inserted as yourself; nobody gets UPDATE/DELETE.
-- ----------------------------------------------------------------------------

drop policy if exists audit_insert on audit_log;
create policy audit_insert on audit_log for insert
  with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 6. UPGRADE apply_stock_movement / complete_sale TO SECURITY DEFINER
--    Direct client writes to inventory/stock_movements/sales/payments stay
--    impossible (RLS on, no write policy) — these two RPCs are the only door,
--    and they check permissions + company ownership themselves before doing
--    anything, so bypassing RLS internally is safe.
-- ----------------------------------------------------------------------------

create or replace function apply_stock_movement(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_variant_id   uuid,
  p_type         stock_movement_type,
  p_quantity     numeric,
  p_ref_table    text,
  p_ref_id       uuid,
  p_operator_id  uuid,
  p_note         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current numeric(18,3);
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('inventory','edit') then
    raise exception 'FORBIDDEN: missing inventory edit permission' using errcode = '42501';
  end if;

  insert into inventory (warehouse_id, variant_id, on_hand, reserved)
  values (p_warehouse_id, p_variant_id, 0, 0)
  on conflict (warehouse_id, variant_id) do nothing;

  select on_hand into v_current
  from inventory
  where warehouse_id = p_warehouse_id and variant_id = p_variant_id
  for update;

  if v_current + p_quantity < 0 then
    raise exception 'INSUFFICIENT_STOCK: available %, requested %', v_current, -p_quantity
      using errcode = 'P0001';
  end if;

  update inventory
  set on_hand = on_hand + p_quantity
  where warehouse_id = p_warehouse_id and variant_id = p_variant_id;

  insert into stock_movements
    (company_id, warehouse_id, variant_id, type, quantity, ref_table, ref_id, operator_id, note)
  values
    (p_company_id, p_warehouse_id, p_variant_id, p_type, p_quantity, p_ref_table, p_ref_id, p_operator_id, p_note);
end;
$$;

revoke all on function apply_stock_movement(uuid,uuid,uuid,stock_movement_type,numeric,text,uuid,uuid,text) from public;
grant execute on function apply_stock_movement(uuid,uuid,uuid,stock_movement_type,numeric,text,uuid,uuid,text) to authenticated;

create or replace function complete_sale(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_customer_id  uuid,
  p_operator_id  uuid,
  p_channel      text,
  p_document_no  text,
  p_items        jsonb,
  p_payments     jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id   uuid;
  v_item      jsonb;
  v_pay       jsonb;
  v_subtotal  numeric(18,2) := 0;
  v_vat_total numeric(18,2) := 0;
  v_line      numeric(18,2);
  v_paid      numeric(18,2);
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('sales','edit') then
    raise exception 'FORBIDDEN: missing sales edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into sales (company_id, document_no, warehouse_id, customer_id, operator_id, channel, status)
  values (p_company_id, p_document_no, p_warehouse_id, p_customer_id, p_operator_id, p_channel, 'fulfilled')
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := (v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric
              - coalesce((v_item->>'discount')::numeric, 0);

    insert into sale_items (sale_id, variant_id, quantity, unit_price, discount, vat_rate, line_total)
    values (
      v_sale_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric, coalesce((v_item->>'discount')::numeric, 0),
      coalesce((v_item->>'vat_rate')::numeric, 20.00), v_line
    );

    perform apply_stock_movement(
      p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
      'sale', -(v_item->>'quantity')::numeric,
      'sales', v_sale_id, p_operator_id, null
    );

    v_subtotal  := v_subtotal + v_line;
    v_vat_total := v_vat_total + v_line * coalesce((v_item->>'vat_rate')::numeric, 20.00) / 100;
  end loop;

  select coalesce(sum((p->>'amount')::numeric), 0) into v_paid
  from jsonb_array_elements(p_payments) p;

  if v_paid < (v_subtotal + v_vat_total) - 0.01 then
    raise exception 'PAYMENT_INSUFFICIENT: total %, paid %', (v_subtotal + v_vat_total), v_paid
      using errcode = 'P0001';
  end if;

  update sales
  set subtotal = v_subtotal, vat_total = v_vat_total, total = v_subtotal + v_vat_total
  where id = v_sale_id;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    insert into payments (company_id, ref_table, ref_id, method, amount, operator_id)
    values (p_company_id, 'sales', v_sale_id, (v_pay->>'method')::payment_method,
            (v_pay->>'amount')::numeric, p_operator_id);
  end loop;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (p_operator_id, 'SALE_COMPLETED', 'sales', v_sale_id::text,
          jsonb_build_object('total', v_subtotal + v_vat_total, 'document_no', p_document_no));

  return v_sale_id;
end;
$$;

revoke all on function complete_sale(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb) from public;
grant execute on function complete_sale(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb) to authenticated;
