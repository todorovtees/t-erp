-- ============================================================================
-- T-ERP  |  0022_purchase_requests.sql
-- Purchase requests (spec §20, Aton: "заявки за доставки - следи състояние,
-- групиране/разделяне по складове, оптимизиране на доставчици"). Doesn't
-- move stock, so — unlike most of this schema — it's fine as plain RLS-
-- gated table writes rather than needing an RPC.
-- ============================================================================

create table purchase_requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  warehouse_id uuid not null references warehouses(id),
  supplier_id  uuid references suppliers(id),
  operator_id  uuid references app_users(id),
  status       text not null default 'draft' check (status in ('draft', 'sent', 'fulfilled', 'cancelled')),
  note         text,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table purchase_request_items (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references purchase_requests(id) on delete cascade,
  variant_id         uuid not null references product_variants(id),
  suggested_quantity numeric(18,3),
  requested_quantity numeric(18,3) not null check (requested_quantity > 0)
);

alter table purchase_requests enable row level security;
alter table purchase_request_items enable row level security;

create policy purchase_requests_read on purchase_requests for select using (company_id = auth_company_id());
create policy purchase_requests_write on purchase_requests for insert
  with check (company_id = auth_company_id() and has_permission('purchases', 'edit') and operator_id = auth.uid());
create policy purchase_requests_update on purchase_requests for update
  using (company_id = auth_company_id() and has_permission('purchases', 'edit'));

create policy purchase_request_items_read on purchase_request_items for select
  using (request_id in (select id from purchase_requests where company_id = auth_company_id()));
create policy purchase_request_items_write on purchase_request_items for insert
  with check (
    has_permission('purchases', 'edit')
    and request_id in (select id from purchase_requests where company_id = auth_company_id())
  );

create view v_purchase_requests_list
with (security_invoker = true)
as
select
  pr.id, pr.company_id, pr.document_no, pr.status, pr.note, pr.created_at,
  w.name as warehouse_name, s.name as supplier_name, u.full_name as operator_name,
  (select count(*) from purchase_request_items i where i.request_id = pr.id) as item_count
from purchase_requests pr
join warehouses w on w.id = pr.warehouse_id
left join suppliers s on s.id = pr.supplier_id
left join app_users u on u.id = pr.operator_id;

grant select on v_purchase_requests_list to authenticated;

-- ----------------------------------------------------------------------------
-- suggest_purchase_request_items() — variants below minimum stock in a
-- warehouse, with the exact "top up to minimum" suggestion from spec §20's
-- own worked example (on_hand 2, min 20 -> suggested 18).
-- ----------------------------------------------------------------------------

create or replace function suggest_purchase_request_items(p_company_id uuid, p_warehouse_id uuid)
returns table (variant_id uuid, product_name text, sku text, on_hand numeric, min_stock numeric, suggested_quantity numeric)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, p.name, v.sku, coalesce(inv.on_hand, 0), p.min_stock,
         p.min_stock - coalesce(inv.on_hand, 0)
  from product_variants v
  join products p on p.id = v.product_id
  left join inventory inv on inv.variant_id = v.id and inv.warehouse_id = p_warehouse_id
  where p.company_id = p_company_id
    and p_company_id = auth_company_id()
    and p.is_active
    and coalesce(inv.on_hand, 0) < p.min_stock
  order by (p.min_stock - coalesce(inv.on_hand, 0)) desc;
$$;

revoke all on function suggest_purchase_request_items(uuid, uuid) from public;
grant execute on function suggest_purchase_request_items(uuid, uuid) to authenticated;
