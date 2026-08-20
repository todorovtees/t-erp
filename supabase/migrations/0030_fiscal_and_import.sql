-- ============================================================================
-- T-ERP  |  0030_fiscal_and_import.sql
-- Part 1 — fiscal device receipt log (spec §24). The actual
-- FiscalDeviceAdapter abstraction lives in frontend/js/lib/fiscal-adapter.js
-- as a real interface with a MockFiscalDriver — genuinely useful (matches
-- the spec's own instruction not to wire business logic directly to one
-- device model), just not connected to real hardware since none exists to
-- test against. This table logs whatever any driver (mock or real) reports.
--
-- Part 2 — import staging (spec §32: preview/validate/error-list/duplicate-
-- detection before committing an import). A holding table the UI parses
-- CSV/XLSX rows into client-side, so bad rows can be reviewed before
-- anything touches products/customers/inventory for real.
-- ============================================================================

create table fiscal_receipts (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  sale_id        uuid references sales(id),
  device_serial  text,
  fiscal_number  text,
  status         text not null default 'issued' check (status in ('issued', 'storno', 'error')),
  raw_response   jsonb,
  operator_id    uuid references app_users(id),
  created_at     timestamptz not null default now()
);

alter table fiscal_receipts enable row level security;
create policy fiscal_receipts_read on fiscal_receipts for select using (company_id = auth_company_id());

create or replace function record_fiscal_receipt(
  p_company_id   uuid,
  p_sale_id      uuid,
  p_device_serial text,
  p_fiscal_number text,
  p_status        text,
  p_raw_response  jsonb,
  p_operator_id   uuid
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

  insert into fiscal_receipts (company_id, sale_id, device_serial, fiscal_number, status, raw_response, operator_id)
  values (p_company_id, p_sale_id, p_device_serial, p_fiscal_number, p_status, p_raw_response, p_operator_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function record_fiscal_receipt(uuid, uuid, text, text, text, jsonb, uuid) from public;
grant execute on function record_fiscal_receipt(uuid, uuid, text, text, text, jsonb, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Import staging
-- ----------------------------------------------------------------------------

create table import_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  entity_type  text not null check (entity_type in ('products', 'customers', 'suppliers')),
  filename     text,
  status       text not null default 'pending' check (status in ('pending', 'committed', 'cancelled')),
  operator_id  uuid references app_users(id),
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);

create table import_rows (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references import_batches(id) on delete cascade,
  row_number   int not null,
  raw_data     jsonb not null,
  is_valid     boolean not null default true,
  error_message text,
  is_duplicate boolean not null default false,
  committed    boolean not null default false
);

alter table import_batches enable row level security;
alter table import_rows enable row level security;

create policy import_batches_read on import_batches for select using (company_id = auth_company_id());
create policy import_batches_write on import_batches for insert
  with check (company_id = auth_company_id() and has_permission('settings', 'edit') and operator_id = auth.uid());
create policy import_batches_update on import_batches for update
  using (company_id = auth_company_id() and has_permission('settings', 'edit'));

create policy import_rows_read on import_rows for select
  using (batch_id in (select id from import_batches where company_id = auth_company_id()));
create policy import_rows_write on import_rows for insert
  with check (
    has_permission('settings', 'edit')
    and batch_id in (select id from import_batches where company_id = auth_company_id())
  );
create policy import_rows_update on import_rows for update
  using (
    has_permission('settings', 'edit')
    and batch_id in (select id from import_batches where company_id = auth_company_id())
  );

-- ----------------------------------------------------------------------------
-- commit_product_import() — inserts every valid, non-duplicate row of a
-- products import batch as a real product (+ a default variant, same rule
-- as the manual "New Product" form), then marks the batch committed.
-- ----------------------------------------------------------------------------

create or replace function commit_product_import(p_company_id uuid, p_batch_id uuid, p_operator_id uuid)
returns table (inserted_count int, skipped_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_product_id uuid;
  v_inserted int := 0;
  v_skipped  int := 0;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('products', 'edit') then
    raise exception 'FORBIDDEN: missing products edit permission' using errcode = '42501';
  end if;

  for v_row in
    select * from import_rows
    where batch_id = p_batch_id and is_valid and not is_duplicate and not committed
    order by row_number
  loop
    begin
      insert into products (company_id, sku, name, unit, purchase_price, sale_price, vat_rate, min_stock, is_active)
      values (
        p_company_id,
        v_row.raw_data->>'sku', v_row.raw_data->>'name',
        coalesce(v_row.raw_data->>'unit', 'pcs'),
        coalesce((v_row.raw_data->>'purchase_price')::numeric, 0),
        coalesce((v_row.raw_data->>'sale_price')::numeric, 0),
        coalesce((v_row.raw_data->>'vat_rate')::numeric, 20),
        coalesce((v_row.raw_data->>'min_stock')::numeric, 0),
        true
      )
      returning id into v_product_id;

      insert into product_variants (product_id, sku, is_active)
      values (v_product_id, v_row.raw_data->>'sku', true);

      update import_rows set committed = true where id = v_row.id;
      v_inserted := v_inserted + 1;
    exception when others then
      update import_rows set is_valid = false, error_message = sqlerrm where id = v_row.id;
      v_skipped := v_skipped + 1;
    end;
  end loop;

  update import_batches set status = 'committed', committed_at = now() where id = p_batch_id;

  return query select v_inserted, v_skipped;
end;
$$;

revoke all on function commit_product_import(uuid, uuid, uuid) from public;
grant execute on function commit_product_import(uuid, uuid, uuid) to authenticated;
