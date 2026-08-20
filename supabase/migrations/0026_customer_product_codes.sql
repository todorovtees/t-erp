-- ============================================================================
-- T-ERP  |  0026_customer_product_codes.sql
-- Per-customer product codes (spec §33): a customer's own SKU for a product,
-- used for order-taking and import/export matching.
-- ============================================================================

create table customer_product_codes (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  variant_id    uuid not null references product_variants(id) on delete cascade,
  customer_code text not null,
  created_at    timestamptz not null default now(),
  unique (customer_id, variant_id)
);

create index idx_customer_product_codes_lookup on customer_product_codes(customer_id, customer_code);

alter table customer_product_codes enable row level security;

create policy customer_product_codes_read on customer_product_codes for select
  using (customer_id in (select id from customers where company_id = auth_company_id()));
create policy customer_product_codes_write on customer_product_codes for insert
  with check (
    has_permission('customers', 'edit')
    and customer_id in (select id from customers where company_id = auth_company_id())
  );
create policy customer_product_codes_delete on customer_product_codes for delete
  using (
    has_permission('customers', 'edit')
    and customer_id in (select id from customers where company_id = auth_company_id())
  );
