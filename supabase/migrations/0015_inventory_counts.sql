-- ============================================================================
-- T-ERP  |  0015_inventory_counts.sql
-- Physical inventory counts (spec §60). Follows the spec's own process
-- exactly: create count -> snapshot expected qty -> enter counted qty ->
-- compare -> require approval -> THEN create adjustment stock_movements.
-- Nothing ever writes to inventory.on_hand directly, even here — approval
-- routes through apply_stock_movement() like every other stock change.
-- ============================================================================

create table inventory_counts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  warehouse_id uuid not null references warehouses(id),
  status       text not null default 'draft' check (status in ('draft', 'counting', 'pending_approval', 'approved', 'cancelled')),
  operator_id  uuid references app_users(id),
  approved_by  uuid references app_users(id),
  created_at   timestamptz not null default now(),
  approved_at  timestamptz
);

create table inventory_count_items (
  id           uuid primary key default gen_random_uuid(),
  count_id     uuid not null references inventory_counts(id) on delete cascade,
  variant_id   uuid not null references product_variants(id),
  expected_qty numeric(18,3) not null,
  counted_qty  numeric(18,3),
  unique (count_id, variant_id)
);

alter table inventory_counts enable row level security;
alter table inventory_count_items enable row level security;

create policy inventory_counts_read on inventory_counts for select using (company_id = auth_company_id());
create policy inventory_count_items_read on inventory_count_items for select
  using (count_id in (select id from inventory_counts where company_id = auth_company_id()));

-- Entering counted quantities is a low-risk, easily-corrected action (the
-- adjustment only actually happens on approval), so it's a plain RLS-gated
-- UPDATE rather than needing its own RPC.
create policy inventory_count_items_update on inventory_count_items for update
  using (
    has_permission('inventory', 'edit')
    and count_id in (
      select id from inventory_counts
      where company_id = auth_company_id() and status in ('draft', 'counting')
    )
  );

create view v_inventory_count_items_detail
with (security_invoker = true)
as
select
  ici.id, ici.count_id, ici.variant_id, ici.expected_qty, ici.counted_qty,
  (ici.counted_qty - ici.expected_qty) as difference,
  p.name as product_name, v.sku
from inventory_count_items ici
join product_variants v on v.id = ici.variant_id
join products p on p.id = v.product_id;

grant select on v_inventory_count_items_detail to authenticated;

-- ----------------------------------------------------------------------------
-- start_inventory_count() — snapshots current on_hand for the given variants
-- (or every variant with stock in the warehouse, if none specified) as the
-- "expected" quantity to count against.
-- ----------------------------------------------------------------------------

create or replace function start_inventory_count(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_operator_id  uuid,
  p_variant_ids  uuid[] default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count_id uuid;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('inventory', 'edit') then
    raise exception 'FORBIDDEN: missing inventory edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into inventory_counts (company_id, warehouse_id, operator_id, status)
  values (p_company_id, p_warehouse_id, p_operator_id, 'counting')
  returning id into v_count_id;

  insert into inventory_count_items (count_id, variant_id, expected_qty)
  select v_count_id, inv.variant_id, inv.on_hand
  from inventory inv
  join product_variants v on v.id = inv.variant_id
  join products p on p.id = v.product_id
  where inv.warehouse_id = p_warehouse_id
    and p.company_id = p_company_id
    and (p_variant_ids is null or inv.variant_id = any(p_variant_ids));

  return v_count_id;
end;
$$;

revoke all on function start_inventory_count(uuid, uuid, uuid, uuid[]) from public;
grant execute on function start_inventory_count(uuid, uuid, uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- approve_inventory_count() — for every item with a difference, create the
-- adjustment movement; only after that succeeds does status become approved.
-- ----------------------------------------------------------------------------

create or replace function approve_inventory_count(
  p_company_id uuid,
  p_count_id   uuid,
  p_operator_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count inventory_counts%rowtype;
  v_item  record;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('inventory', 'full') then
    raise exception 'FORBIDDEN: approving a count requires full inventory permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  select * into v_count from inventory_counts where id = p_count_id and company_id = p_company_id;
  if not found then raise exception 'COUNT_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_count.status = 'approved' then raise exception 'ALREADY_APPROVED'; end if;

  for v_item in
    select variant_id, expected_qty, counted_qty
    from inventory_count_items
    where count_id = p_count_id and counted_qty is not null and counted_qty <> expected_qty
  loop
    perform apply_stock_movement(
      p_company_id, v_count.warehouse_id, v_item.variant_id,
      'count_adjustment', v_item.counted_qty - v_item.expected_qty,
      'inventory_counts', p_count_id, p_operator_id,
      format('Count adjustment: expected %s, counted %s', v_item.expected_qty, v_item.counted_qty)
    );
  end loop;

  update inventory_counts
  set status = 'approved', approved_by = p_operator_id, approved_at = now()
  where id = p_count_id;
end;
$$;

revoke all on function approve_inventory_count(uuid, uuid, uuid) from public;
grant execute on function approve_inventory_count(uuid, uuid, uuid) to authenticated;
