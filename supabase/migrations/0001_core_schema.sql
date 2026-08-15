-- ============================================================================
-- T-ERP  |  0001_core_schema.sql
-- Core foundation: companies, users/roles, warehouses, products, inventory,
-- customers, suppliers, audit log.
-- Target: PostgreSQL 15+ (Supabase)
-- ============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "citext";        -- case-insensitive emails/codes

-- ----------------------------------------------------------------------------
-- 0. ENUM TYPES
-- ----------------------------------------------------------------------------

create type user_role as enum (
  'super_admin', 'admin', 'manager', 'warehouse_operator',
  'sales_operator', 'cashier', 'accountant', 'read_only'
);

create type permission_level as enum ('none', 'view', 'edit', 'full');

create type stock_movement_type as enum (
  'purchase_receipt', 'sale', 'transfer_out', 'transfer_in',
  'write_off', 'return_in', 'return_out', 'adjustment', 'count_adjustment'
);

create type document_status as enum (
  'draft', 'sent', 'in_transit', 'received', 'confirmed',
  'partially_fulfilled', 'fulfilled', 'cancelled'
);

create type payment_method as enum (
  'cash', 'card', 'bank_transfer', 'cheque', 'voucher', 'coupon', 'mixed'
);

-- ----------------------------------------------------------------------------
-- 1. COMPANIES  (multi-company ready, per spec §65)
-- ----------------------------------------------------------------------------

create table companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  eik           text,                 -- ЕИК
  vat_number    text,
  address       text,
  base_currency text not null default 'BGN',
  created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. USERS  (extends Supabase auth.users 1:1)
-- ----------------------------------------------------------------------------

create table app_users (
  id            uuid primary key references auth.users(id) on delete cascade,
  company_id    uuid not null references companies(id),
  full_name     text not null,
  username      citext not null unique,
  role          user_role not null default 'read_only',
  pin_hash      text,                 -- POS PIN login, hashed server-side
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    timestamptz not null default now()
);

create table role_permissions (
  role       user_role not null,
  module     text not null,          -- e.g. 'inventory', 'finance', 'sales'
  level      permission_level not null default 'none',
  can_approve boolean not null default false,
  can_export  boolean not null default false,
  can_print   boolean not null default false,
  primary key (role, module)
);

-- ----------------------------------------------------------------------------
-- 3. WAREHOUSES
-- ----------------------------------------------------------------------------

create table warehouses (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  code        text not null,
  name        text not null,
  address     text,
  manager_id  uuid references app_users(id),
  phone       text,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now(),
  unique (company_id, code)
);

-- ----------------------------------------------------------------------------
-- 4. PRODUCTS & VARIANTS
-- ----------------------------------------------------------------------------

create table categories (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  parent_id  uuid references categories(id),
  name       text not null
);

create table brands (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name       text not null
);

create table products (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  sku             text not null,
  name            text not null,
  description     text,
  category_id     uuid references categories(id),
  brand_id        uuid references brands(id),
  unit            text not null default 'pcs',   -- pcs/kg/g/l/ml/m/box/pack...
  purchase_price  numeric(18,4) not null default 0,
  sale_price      numeric(18,4) not null default 0,
  vat_rate        numeric(5,2) not null default 20.00,
  min_stock       numeric(18,3) not null default 0,
  max_stock       numeric(18,3),
  track_batches   boolean not null default false,
  track_serials   boolean not null default false,
  track_expiry    boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (company_id, sku)
);

-- Variants (color/size/etc.) - a product with no variants gets one implicit
-- "default" variant row so inventory/pricing always references variant_id.
create table product_variants (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  sku            text not null,
  color          text,
  size           text,
  material       text,
  sale_price     numeric(18,4),        -- overrides product.sale_price if set
  is_active      boolean not null default true,
  unique (sku)
);

create table barcodes (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants(id) on delete cascade,
  barcode     text not null unique,
  type        text not null default 'EAN13' check (type in ('EAN13','EAN8','CODE128','QR','CUSTOM')),
  is_primary  boolean not null default false
);

-- ----------------------------------------------------------------------------
-- 5. INVENTORY  (current stock snapshot per warehouse + variant)
-- ----------------------------------------------------------------------------

create table inventory (
  warehouse_id  uuid not null references warehouses(id),
  variant_id    uuid not null references product_variants(id),
  on_hand       numeric(18,3) not null default 0,
  reserved      numeric(18,3) not null default 0,
  primary key (warehouse_id, variant_id),
  constraint on_hand_non_negative check (on_hand >= 0)
);

-- Full audit trail of every stock change. inventory.on_hand is a
-- materialized snapshot; stock_movements is the source of truth.
create table stock_movements (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  warehouse_id   uuid not null references warehouses(id),
  variant_id     uuid not null references product_variants(id),
  type           stock_movement_type not null,
  quantity       numeric(18,3) not null,   -- signed: + in, - out
  ref_table      text,                     -- e.g. 'sales', 'purchases', 'transfers'
  ref_id         uuid,
  batch_id       uuid,
  operator_id    uuid references app_users(id),
  note           text,
  created_at     timestamptz not null default now()
);

create index idx_stock_movements_variant_wh on stock_movements(warehouse_id, variant_id);
create index idx_inventory_variant on inventory(variant_id);

-- ----------------------------------------------------------------------------
-- 6. CUSTOMERS / SUPPLIERS
-- ----------------------------------------------------------------------------

create table customers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  name            text not null,
  company_name    text,
  eik             text,
  vat_number      text,
  address         text,
  phone           text,
  email           citext,
  credit_limit    numeric(18,2) not null default 0,
  currency        text not null default 'BGN',
  balance         numeric(18,2) not null default 0,
  created_at      timestamptz not null default now()
);

create table suppliers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  name            text not null,
  eik             text,
  vat_number      text,
  address         text,
  phone           text,
  email           citext,
  balance         numeric(18,2) not null default 0,
  created_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 7. AUDIT LOG  (append-only; no standard role may delete from it)
-- ----------------------------------------------------------------------------

create table audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references app_users(id),
  action      text not null,
  target_table text,
  target_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table companies enable row level security;
alter table app_users enable row level security;
alter table warehouses enable row level security;
alter table categories enable row level security;
alter table brands enable row level security;
alter table products enable row level security;
alter table product_variants enable row level security;
alter table barcodes enable row level security;
alter table inventory enable row level security;
alter table stock_movements enable row level security;
alter table customers enable row level security;
alter table suppliers enable row level security;
alter table audit_log enable row level security;

-- Helper: current user's company_id
create or replace function auth_company_id() returns uuid
language sql stable security definer as $$
  select company_id from app_users where id = auth.uid();
$$;

-- Baseline policy pattern: any authenticated user may READ rows in their own
-- company; WRITE policies are added per-module migration once role_permissions
-- logic is wired in (kept minimal here on purpose - tighten before production).
create policy company_read on companies for select using (id = auth_company_id());
create policy users_read on app_users for select using (company_id = auth_company_id());
create policy warehouses_read on warehouses for select using (company_id = auth_company_id());
create policy products_read on products for select using (company_id = auth_company_id());
create policy variants_read on product_variants for select
  using (product_id in (select id from products where company_id = auth_company_id()));
create policy inventory_read on inventory for select
  using (warehouse_id in (select id from warehouses where company_id = auth_company_id()));
create policy customers_read on customers for select using (company_id = auth_company_id());
create policy suppliers_read on suppliers for select using (company_id = auth_company_id());
create policy audit_read on audit_log for select
  using (user_id in (select id from app_users where company_id = auth_company_id()));

-- Audit log: INSERT only, never UPDATE/DELETE for any client role.
create policy audit_insert on audit_log for insert with check (true);

-- ----------------------------------------------------------------------------
-- 9. ATOMIC STOCK MOVEMENT FUNCTION  (prevents overselling, spec §47)
-- ----------------------------------------------------------------------------
-- Locks the inventory row, applies delta, refuses negative on_hand.
-- All sale/purchase/transfer logic MUST go through this function instead of
-- writing to `inventory` directly.

create or replace function apply_stock_movement(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_variant_id   uuid,
  p_type         stock_movement_type,
  p_quantity     numeric,     -- signed
  p_ref_table    text,
  p_ref_id       uuid,
  p_operator_id  uuid,
  p_note         text default null
) returns void
language plpgsql as $$
declare
  v_current numeric(18,3);
begin
  insert into inventory (warehouse_id, variant_id, on_hand, reserved)
  values (p_warehouse_id, p_variant_id, 0, 0)
  on conflict (warehouse_id, variant_id) do nothing;

  select on_hand into v_current
  from inventory
  where warehouse_id = p_warehouse_id and variant_id = p_variant_id
  for update;                                   -- row lock: serializes concurrent sales

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
