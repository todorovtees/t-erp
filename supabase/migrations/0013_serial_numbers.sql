-- ============================================================================
-- T-ERP  |  0013_serial_numbers.sql
-- Serial number tracking (spec §10). Unlike batches, serials identify a
-- single physical unit, so — unlike FEFO batch consumption — the specific
-- serial being sold has to come from the client (someone has to actually
-- know/scan which unit is leaving). complete_sale() accepts an optional
-- `serials: string[]` per line and validates it against real in-stock rows;
-- an invalid serial rolls back the whole sale, same guarantee as insufficient
-- stock.
-- ============================================================================

create table serial_numbers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  variant_id     uuid not null references product_variants(id),
  serial         text not null,
  warehouse_id   uuid references warehouses(id),
  status         text not null default 'in_stock' check (status in ('in_stock','sold','returned','defective')),
  supplier_id    uuid references suppliers(id),
  received_date  date default current_date,
  sold_date      date,
  customer_id    uuid references customers(id),
  sale_id        uuid references sales(id),
  warranty_until date,
  created_at     timestamptz not null default now(),
  unique (variant_id, serial)
);

create index idx_serials_variant_status on serial_numbers(variant_id, status);

alter table serial_numbers enable row level security;
create policy serial_numbers_read on serial_numbers for select using (company_id = auth_company_id());
-- No direct write policy — only via receive_purchase()/complete_sale()/void_sale() below.

-- ----------------------------------------------------------------------------
-- Extend receive_purchase(): optional per-item `serials: string[]`, one row
-- created per serial with status 'in_stock'.
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
  v_serial      text;
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

    if jsonb_typeof(v_item->'serials') = 'array' then
      for v_serial in select jsonb_array_elements_text(v_item->'serials') loop
        insert into serial_numbers (company_id, variant_id, warehouse_id, serial, supplier_id, status)
        values (p_company_id, (v_item->>'variant_id')::uuid, p_warehouse_id, v_serial, p_supplier_id, 'in_stock');
      end loop;
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
-- Extend complete_sale(): optional per-item `serials: string[]`. Each must
-- already exist, be 'in_stock', and match the variant — otherwise the whole
-- sale rolls back, same guarantee as an oversell.
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
  v_serial    text;
  v_updated   int;
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

    if jsonb_typeof(v_item->'serials') = 'array' then
      for v_serial in select jsonb_array_elements_text(v_item->'serials') loop
        update serial_numbers
        set status = 'sold', sold_date = current_date, customer_id = p_customer_id, sale_id = v_sale_id
        where variant_id = (v_item->>'variant_id')::uuid and serial = v_serial and status = 'in_stock';

        get diagnostics v_updated = row_count;
        if v_updated = 0 then
          raise exception 'SERIAL_NOT_AVAILABLE: % is not in stock for this product', v_serial
            using errcode = 'P0001';
        end if;
      end loop;
    end if;

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
-- Extend void_sale(): serials sold in a voided sale return to 'in_stock'.
-- ----------------------------------------------------------------------------

create or replace function void_sale(
  p_company_id  uuid,
  p_sale_id     uuid,
  p_operator_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale  sales%rowtype;
  v_item  record;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('sales', 'full') then
    raise exception 'FORBIDDEN: voiding a sale requires full sales permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  select * into v_sale from sales where id = p_sale_id and company_id = p_company_id;
  if not found then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'ALREADY_CANCELLED';
  end if;

  for v_item in select variant_id, quantity from sale_items where sale_id = p_sale_id loop
    perform apply_stock_movement(
      p_company_id, v_sale.warehouse_id, v_item.variant_id,
      'return_in', v_item.quantity,
      'sales', p_sale_id, p_operator_id, 'Void: sale reversed'
    );
  end loop;

  update serial_numbers
  set status = 'in_stock', sold_date = null, customer_id = null, sale_id = null
  where sale_id = p_sale_id and status = 'sold';

  update sales set status = 'cancelled' where id = p_sale_id;

  insert into audit_log (user_id, action, target_table, target_id, old_value, new_value)
  values (
    p_operator_id, 'SALE_VOIDED', 'sales', p_sale_id::text,
    jsonb_build_object('status', v_sale.status),
    jsonb_build_object('status', 'cancelled')
  );
end;
$$;

revoke all on function void_sale(uuid, uuid, uuid) from public;
grant execute on function void_sale(uuid, uuid, uuid) to authenticated;
