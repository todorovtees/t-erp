-- ============================================================================
-- T-ERP  |  0002_sales_purchases_payments.sql
-- Sales (incl. POS), Purchases, Payments, Cash registers.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SALES
-- ----------------------------------------------------------------------------

create table sales (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  warehouse_id uuid not null references warehouses(id),
  customer_id  uuid references customers(id),
  operator_id  uuid not null references app_users(id),
  channel      text not null default 'store' check (channel in ('store','website','wholesale','pos','ambassador')),
  status       document_status not null default 'draft',
  currency     text not null default 'BGN',
  subtotal     numeric(18,2) not null default 0,
  discount     numeric(18,2) not null default 0,
  vat_total    numeric(18,2) not null default 0,
  total        numeric(18,2) not null default 0,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table sale_items (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references sales(id) on delete cascade,
  variant_id  uuid not null references product_variants(id),
  quantity    numeric(18,3) not null check (quantity > 0),
  unit_price  numeric(18,4) not null,
  discount    numeric(18,2) not null default 0,
  vat_rate    numeric(5,2) not null default 20.00,
  line_total  numeric(18,2) not null
);

-- ----------------------------------------------------------------------------
-- 2. PURCHASES
-- ----------------------------------------------------------------------------

create table purchases (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  warehouse_id uuid not null references warehouses(id),
  supplier_id  uuid references suppliers(id),
  operator_id  uuid not null references app_users(id),
  status       document_status not null default 'draft',
  currency     text not null default 'BGN',
  total        numeric(18,2) not null default 0,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table purchase_items (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid not null references purchases(id) on delete cascade,
  variant_id    uuid not null references product_variants(id),
  quantity      numeric(18,3) not null check (quantity > 0),
  unit_cost     numeric(18,4) not null,
  line_total    numeric(18,2) not null
);

-- ----------------------------------------------------------------------------
-- 3. PAYMENTS
-- ----------------------------------------------------------------------------

create table payments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  ref_table    text not null,        -- 'sales' | 'purchases'
  ref_id       uuid not null,
  method       payment_method not null,
  amount       numeric(18,2) not null,
  currency     text not null default 'BGN',
  operator_id  uuid references app_users(id),
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4. CASH REGISTERS
-- ----------------------------------------------------------------------------

create table cash_registers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  warehouse_id uuid references warehouses(id),
  name        text not null,
  is_open     boolean not null default false
);

create table cash_sessions (
  id                 uuid primary key default gen_random_uuid(),
  cash_register_id   uuid not null references cash_registers(id),
  operator_id        uuid not null references app_users(id),
  opening_balance     numeric(18,2) not null default 0,
  closing_balance_actual numeric(18,2),
  opened_at          timestamptz not null default now(),
  closed_at          timestamptz
);

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------

alter table sales enable row level security;
alter table sale_items enable row level security;
alter table purchases enable row level security;
alter table purchase_items enable row level security;
alter table payments enable row level security;
alter table cash_registers enable row level security;
alter table cash_sessions enable row level security;

create policy sales_read on sales for select using (company_id = auth_company_id());
create policy sale_items_read on sale_items for select
  using (sale_id in (select id from sales where company_id = auth_company_id()));
create policy purchases_read on purchases for select using (company_id = auth_company_id());
create policy purchase_items_read on purchase_items for select
  using (purchase_id in (select id from purchases where company_id = auth_company_id()));
create policy payments_read on payments for select using (company_id = auth_company_id());
create policy cash_registers_read on cash_registers for select using (company_id = auth_company_id());

-- ----------------------------------------------------------------------------
-- 6. ATOMIC "COMPLETE SALE" FUNCTION
-- ----------------------------------------------------------------------------
-- Takes a JSON cart, creates sale + sale_items, decrements stock through
-- apply_stock_movement (so overselling is impossible even with concurrent
-- POS terminals), and records payment(s). Runs as a single DB transaction.

create or replace function complete_sale(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_customer_id  uuid,
  p_operator_id  uuid,
  p_channel      text,
  p_document_no  text,
  p_items        jsonb,     -- [{variant_id, quantity, unit_price, discount, vat_rate}]
  p_payments     jsonb      -- [{method, amount}]
) returns uuid
language plpgsql as $$
declare
  v_sale_id   uuid;
  v_item      jsonb;
  v_pay       jsonb;
  v_subtotal  numeric(18,2) := 0;
  v_vat_total numeric(18,2) := 0;
  v_line      numeric(18,2);
begin
  insert into sales (company_id, document_no, warehouse_id, customer_id, operator_id, channel, status)
  values (p_company_id, p_document_no, p_warehouse_id, p_customer_id, p_operator_id, p_channel, 'fulfilled')
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_line := (v_item->>'quantity')::numeric * (v_item->>'unit_price')::numeric
              - coalesce((v_item->>'discount')::numeric, 0);

    insert into sale_items (sale_id, variant_id, quantity, unit_price, discount, vat_rate, line_total)
    values (
      v_sale_id,
      (v_item->>'variant_id')::uuid,
      (v_item->>'quantity')::numeric,
      (v_item->>'unit_price')::numeric,
      coalesce((v_item->>'discount')::numeric, 0),
      coalesce((v_item->>'vat_rate')::numeric, 20.00),
      v_line
    );

    -- Decrement stock atomically; raises INSUFFICIENT_STOCK and rolls back
    -- the whole sale if not enough is available.
    perform apply_stock_movement(
      p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
      'sale', -(v_item->>'quantity')::numeric,
      'sales', v_sale_id, p_operator_id, null
    );

    v_subtotal  := v_subtotal + v_line;
    v_vat_total := v_vat_total + v_line * coalesce((v_item->>'vat_rate')::numeric, 20.00) / 100;
  end loop;

  update sales
  set subtotal = v_subtotal, vat_total = v_vat_total, total = v_subtotal + v_vat_total
  where id = v_sale_id;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    insert into payments (company_id, ref_table, ref_id, method, amount, operator_id)
    values (p_company_id, 'sales', v_sale_id, (v_pay->>'method')::payment_method,
            (v_pay->>'amount')::numeric, p_operator_id);
  end loop;

  return v_sale_id;
end;
$$;
