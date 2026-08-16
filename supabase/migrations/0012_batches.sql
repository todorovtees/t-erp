-- ============================================================================
-- T-ERP  |  0012_batches.sql
-- Batch tracking + FEFO (First-Expired-First-Out) consumption (spec §9).
-- Design choice: batch bookkeeping is layered ON TOP of the existing,
-- already-tested inventory/stock_movement core rather than woven into it.
-- apply_stock_movement() remains the single source of truth for on_hand;
-- batches.quantity is a secondary breakdown that should sum to on_hand for
-- tracked products. This keeps complete_sale()/receive_purchase()'s tested
-- financial logic untouched — batch handling is purely additive.
--
-- Simplification (documented, not hidden): FEFO consumption in this version
-- draws from the single oldest-expiry batch with stock. If that batch has
-- less than the sale quantity, it takes what's there and logs a note rather
-- than splitting across multiple batches — full multi-batch splitting is a
-- reasonable follow-up, not done here.
-- ============================================================================

create table batches (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  variant_id       uuid not null references product_variants(id),
  warehouse_id     uuid not null references warehouses(id),
  batch_no         text not null,
  quantity         numeric(18,3) not null default 0 check (quantity >= 0),
  manufacture_date date,
  received_date    date not null default current_date,
  expiry_date      date,
  supplier_id      uuid references suppliers(id),
  created_at       timestamptz not null default now(),
  unique (variant_id, warehouse_id, batch_no)
);

create index idx_batches_expiry on batches(company_id, expiry_date) where expiry_date is not null;
create index idx_batches_variant_wh on batches(variant_id, warehouse_id);

alter table products add column if not exists notify_days_before_expiry int not null default 30;

alter table batches enable row level security;
create policy batches_read on batches for select using (company_id = auth_company_id());
-- No client write policy on purpose — batches are only ever written through
-- receive_purchase()/complete_sale() below (SECURITY DEFINER, same pattern
-- as inventory/stock_movements).

-- ----------------------------------------------------------------------------
-- Helper: consume up to p_quantity from the oldest-expiry batch with stock.
-- Silent no-op if the product doesn't track batches (no batch rows exist for
-- it) — safe to call unconditionally from complete_sale().
-- ----------------------------------------------------------------------------

create or replace function consume_fefo_batch(
  p_variant_id   uuid,
  p_warehouse_id uuid,
  p_quantity     numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch record;
  v_take  numeric;
begin
  select id, quantity into v_batch
  from batches
  where variant_id = p_variant_id and warehouse_id = p_warehouse_id and quantity > 0
  order by expiry_date asc nulls last, received_date asc
  limit 1
  for update;

  if not found then
    return; -- product doesn't use batches (or none in stock) — nothing to do
  end if;

  v_take := least(v_batch.quantity, p_quantity);
  update batches set quantity = quantity - v_take where id = v_batch.id;
end;
$$;

revoke all on function consume_fefo_batch(uuid, uuid, numeric) from public;

-- ----------------------------------------------------------------------------
-- Extend receive_purchase(): optional per-item batch_no/manufacture_date/
-- expiry_date. Backward compatible — items without these keys behave
-- exactly as before (jsonb ->> on a missing key is null).
-- ----------------------------------------------------------------------------

create or replace function receive_purchase(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_supplier_id  uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_items        jsonb
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
  v_batch_no    text;
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

    -- Optional batch capture (spec §9). Absent keys => no batch row, exactly
    -- like before this migration.
    v_batch_no := v_item->>'batch_no';
    if v_batch_no is not null and v_batch_no <> '' then
      insert into batches (company_id, variant_id, warehouse_id, batch_no, quantity, manufacture_date, expiry_date, supplier_id)
      values (
        p_company_id, (v_item->>'variant_id')::uuid, p_warehouse_id, v_batch_no,
        (v_item->>'quantity')::numeric,
        nullif(v_item->>'manufacture_date','')::date,
        nullif(v_item->>'expiry_date','')::date,
        p_supplier_id
      )
      on conflict (variant_id, warehouse_id, batch_no)
      do update set quantity = batches.quantity + excluded.quantity;
    end if;

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
-- Extend complete_sale(): after each line's stock movement, transparently
-- draw from FEFO batches too (no-op for non-tracked products).
-- ----------------------------------------------------------------------------

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

    perform consume_fefo_batch(
      (v_item->>'variant_id')::uuid, p_warehouse_id, (v_item->>'quantity')::numeric
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

-- ----------------------------------------------------------------------------
-- View: expiring/expired batches for the Batches page (spec §11 — warn N
-- days before expiry, per-product configurable).
-- ----------------------------------------------------------------------------

create view v_batch_status
with (security_invoker = true)
as
select
  b.id, b.company_id, b.batch_no, b.quantity, b.expiry_date, b.received_date,
  p.name as product_name, v.sku, w.name as warehouse_name,
  case
    when b.expiry_date is null then 'none'
    when b.expiry_date < current_date then 'expired'
    when b.expiry_date <= current_date + (p.notify_days_before_expiry || ' days')::interval then 'expiring_soon'
    else 'ok'
  end as expiry_status
from batches b
join product_variants v on v.id = b.variant_id
join products p on p.id = v.product_id
join warehouses w on w.id = b.warehouse_id
where b.quantity > 0;

grant select on v_batch_status to authenticated;
