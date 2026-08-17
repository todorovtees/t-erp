-- ============================================================================
-- T-ERP  |  0021_customer_orders.sql
-- Customer order subsystem (spec §19, Aton: "поръчки от клиенти - различен
-- статус, нива на изпълнение"). Fulfillment deliberately calls the existing,
-- tested complete_sale() internally rather than re-implementing stock/
-- payment logic — an order becomes a real sale (with all the same
-- atomicity/audit guarantees) the moment any part of it is fulfilled.
-- ============================================================================

create table customer_orders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  customer_id  uuid references customers(id),
  warehouse_id uuid not null references warehouses(id),
  operator_id  uuid references app_users(id),
  status       document_status not null default 'draft',
  note         text,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table customer_order_items (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references customer_orders(id) on delete cascade,
  variant_id         uuid not null references product_variants(id),
  quantity_ordered   numeric(18,3) not null check (quantity_ordered > 0),
  quantity_fulfilled numeric(18,3) not null default 0,
  unit_price         numeric(18,4) not null,
  vat_rate           numeric(5,2) not null default 20.00
);

alter table customer_orders enable row level security;
alter table customer_order_items enable row level security;

create policy customer_orders_read on customer_orders for select using (company_id = auth_company_id());
create policy customer_order_items_read on customer_order_items for select
  using (order_id in (select id from customer_orders where company_id = auth_company_id()));

create view v_customer_orders_list
with (security_invoker = true)
as
select
  co.id, co.company_id, co.document_no, co.status, co.note, co.created_at,
  c.name as customer_name, w.name as warehouse_name, u.full_name as operator_name,
  (select coalesce(sum(quantity_ordered), 0) from customer_order_items i where i.order_id = co.id) as total_ordered,
  (select coalesce(sum(quantity_fulfilled), 0) from customer_order_items i where i.order_id = co.id) as total_fulfilled
from customer_orders co
left join customers c on c.id = co.customer_id
join warehouses w on w.id = co.warehouse_id
left join app_users u on u.id = co.operator_id;

grant select on v_customer_orders_list to authenticated;

-- ----------------------------------------------------------------------------
-- create_customer_order() — draft, no stock movement.
-- ----------------------------------------------------------------------------

create or replace function create_customer_order(
  p_company_id   uuid,
  p_customer_id  uuid,
  p_warehouse_id uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_note         text,
  p_items        jsonb   -- [{variant_id, quantity, unit_price, vat_rate}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item     jsonb;
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

  insert into customer_orders (company_id, document_no, customer_id, warehouse_id, operator_id, status, note)
  values (p_company_id, p_document_no, p_customer_id, p_warehouse_id, p_operator_id, 'received', p_note)
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into customer_order_items (order_id, variant_id, quantity_ordered, unit_price, vat_rate)
    values (
      v_order_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric, coalesce((v_item->>'vat_rate')::numeric, 20.00)
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function create_customer_order(uuid, uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function create_customer_order(uuid, uuid, uuid, uuid, text, text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- fulfill_customer_order() — turns some or all remaining ordered quantity
-- into a real sale via complete_sale(), then updates fulfilled quantities
-- and rolls the order status up to partially_fulfilled/fulfilled.
-- ----------------------------------------------------------------------------

create or replace function fulfill_customer_order(
  p_company_id  uuid,
  p_order_id    uuid,
  p_operator_id uuid,
  p_items       jsonb,   -- [{variant_id, quantity}] — quantity being fulfilled NOW
  p_payments    jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order      customer_orders%rowtype;
  v_sale_id    uuid;
  v_sale_items jsonb := '[]'::jsonb;
  v_item       jsonb;
  v_order_item customer_order_items%rowtype;
  v_total_ordered   numeric;
  v_total_fulfilled numeric;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;

  select * into v_order from customer_orders where id = p_order_id and company_id = p_company_id;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_order.status in ('fulfilled', 'cancelled') then
    raise exception 'INVALID_STATUS: order is already % ', v_order.status;
  end if;

  -- Build the complete_sale() item list from the order's own priced lines,
  -- validating the requested fulfillment doesn't exceed what's left to fulfill.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_order_item
    from customer_order_items
    where order_id = p_order_id and variant_id = (v_item->>'variant_id')::uuid;

    if not found then
      raise exception 'ORDER_ITEM_NOT_FOUND: variant % is not on this order', v_item->>'variant_id';
    end if;
    if (v_item->>'quantity')::numeric > (v_order_item.quantity_ordered - v_order_item.quantity_fulfilled) then
      raise exception 'OVER_FULFILL: only % left to fulfill for this line',
        (v_order_item.quantity_ordered - v_order_item.quantity_fulfilled);
    end if;

    v_sale_items := v_sale_items || jsonb_build_object(
      'variant_id', v_order_item.variant_id,
      'quantity', (v_item->>'quantity')::numeric,
      'unit_price', v_order_item.unit_price,
      'discount', 0,
      'vat_rate', v_order_item.vat_rate
    );
  end loop;

  v_sale_id := complete_sale(
    p_company_id, v_order.warehouse_id, v_order.customer_id, p_operator_id,
    'store', 'ORD-' || v_order.document_no || '-' || substr(gen_random_uuid()::text, 1, 8),
    v_sale_items, p_payments
  );

  for v_item in select * from jsonb_array_elements(p_items) loop
    update customer_order_items
    set quantity_fulfilled = quantity_fulfilled + (v_item->>'quantity')::numeric
    where order_id = p_order_id and variant_id = (v_item->>'variant_id')::uuid;
  end loop;

  select sum(quantity_ordered), sum(quantity_fulfilled) into v_total_ordered, v_total_fulfilled
  from customer_order_items where order_id = p_order_id;

  update customer_orders
  set status = (case
    when v_total_fulfilled >= v_total_ordered then 'fulfilled'
    else 'partially_fulfilled'
  end)::document_status
  where id = p_order_id;

  return v_sale_id;
end;
$$;

revoke all on function fulfill_customer_order(uuid, uuid, uuid, jsonb, jsonb) from public;
grant execute on function fulfill_customer_order(uuid, uuid, uuid, jsonb, jsonb) to authenticated;
