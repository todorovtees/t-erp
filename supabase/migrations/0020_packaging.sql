-- ============================================================================
-- T-ERP  |  0020_packaging.sql
-- Packaging deposit tracking (spec §29, Aton: "следи дадения и върнатия
-- амбалаж към/от клиент и доставчик"). Crates, pallets, containers lent out
-- with sales and expected back — a running ledger per customer/supplier per
-- packaging type, not part of the sellable inventory system.
-- ============================================================================

create table packaging_types (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id),
  name               text not null,             -- 'Каси', 'Палети', 'Контейнери'
  unit_deposit_value numeric(18,2) default 0,    -- optional monetary deposit per unit
  created_at         timestamptz not null default now(),
  unique (company_id, name)
);

create table packaging_ledger (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies(id),
  packaging_type_id  uuid not null references packaging_types(id),
  customer_id        uuid references customers(id),
  supplier_id        uuid references suppliers(id),
  direction          text not null check (direction in ('given', 'returned')),
  quantity           numeric(18,3) not null check (quantity > 0),
  note               text,
  operator_id        uuid references app_users(id),
  created_at         timestamptz not null default now(),
  check (
    (customer_id is not null and supplier_id is null) or
    (supplier_id is not null and customer_id is null)
  )
);

create index idx_packaging_ledger_customer on packaging_ledger(customer_id) where customer_id is not null;
create index idx_packaging_ledger_supplier on packaging_ledger(supplier_id) where supplier_id is not null;

alter table packaging_types enable row level security;
alter table packaging_ledger enable row level security;

create policy packaging_types_read on packaging_types for select using (company_id = auth_company_id());
create policy packaging_types_write on packaging_types for insert
  with check (company_id = auth_company_id() and has_permission('inventory', 'edit'));

create policy packaging_ledger_read on packaging_ledger for select using (company_id = auth_company_id());
create policy packaging_ledger_write on packaging_ledger for insert
  with check (
    company_id = auth_company_id()
    and has_permission('inventory', 'edit')
    and operator_id = auth.uid()
  );

-- "given" minus "returned" per customer = how much they still owe us;
-- per supplier = how much they still owe us back (packaging we sent them).
create view v_packaging_balances
with (security_invoker = true)
as
select
  pl.company_id, pt.name as packaging_type,
  pl.customer_id, c.name as customer_name,
  pl.supplier_id, s.name as supplier_name,
  sum(case when pl.direction = 'given' then pl.quantity else -pl.quantity end) as outstanding
from packaging_ledger pl
join packaging_types pt on pt.id = pl.packaging_type_id
left join customers c on c.id = pl.customer_id
left join suppliers s on s.id = pl.supplier_id
group by pl.company_id, pt.name, pl.customer_id, c.name, pl.supplier_id, s.name
having sum(case when pl.direction = 'given' then pl.quantity else -pl.quantity end) <> 0;

grant select on v_packaging_balances to authenticated;
