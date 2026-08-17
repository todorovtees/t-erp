-- ============================================================================
-- T-ERP  |  0019_write_offs.sql
-- Write-off / scrap (spec §7 "бракуване", Aton's "Изписвания"/"Видове
-- връщания"). A documented reason for removing stock without a sale — the
-- stock_movement_type enum already has 'write_off'; this migration adds the
-- document layer around it (header + reason + line items), same pattern as
-- every other stock-moving flow in this schema.
-- ============================================================================

create table write_offs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  document_no  text not null,
  warehouse_id uuid not null references warehouses(id),
  reason       text not null check (reason in ('damaged', 'expired', 'lost', 'internal_use', 'other')),
  operator_id  uuid references app_users(id),
  note         text,
  created_at   timestamptz not null default now(),
  unique (company_id, document_no)
);

create table write_off_items (
  id           uuid primary key default gen_random_uuid(),
  write_off_id uuid not null references write_offs(id) on delete cascade,
  variant_id   uuid not null references product_variants(id),
  quantity     numeric(18,3) not null check (quantity > 0)
);

alter table write_offs enable row level security;
alter table write_off_items enable row level security;

create policy write_offs_read on write_offs for select using (company_id = auth_company_id());
create policy write_off_items_read on write_off_items for select
  using (write_off_id in (select id from write_offs where company_id = auth_company_id()));

create view v_write_offs_list
with (security_invoker = true)
as
select
  wo.id, wo.company_id, wo.document_no, wo.reason, wo.note, wo.created_at,
  w.name as warehouse_name, u.full_name as operator_name,
  (select count(*) from write_off_items woi where woi.write_off_id = wo.id) as item_count
from write_offs wo
join warehouses w on w.id = wo.warehouse_id
left join app_users u on u.id = wo.operator_id;

grant select on v_write_offs_list to authenticated;

-- ----------------------------------------------------------------------------
-- create_write_off() — requires 'inventory' FULL (scrapping stock is more
-- consequential than a routine adjustment, same reasoning as void_sale
-- needing 'sales' full).
-- ----------------------------------------------------------------------------

create or replace function create_write_off(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_operator_id  uuid,
  p_document_no  text,
  p_reason       text,
  p_note         text,
  p_items        jsonb   -- [{variant_id, quantity}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_write_off_id uuid;
  v_item         jsonb;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('inventory', 'full') then
    raise exception 'FORBIDDEN: write-offs require full inventory permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  insert into write_offs (company_id, document_no, warehouse_id, reason, operator_id, note)
  values (p_company_id, p_document_no, p_warehouse_id, p_reason, p_operator_id, p_note)
  returning id into v_write_off_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into write_off_items (write_off_id, variant_id, quantity)
    values (v_write_off_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric);

    perform apply_stock_movement(
      p_company_id, p_warehouse_id, (v_item->>'variant_id')::uuid,
      'write_off', -(v_item->>'quantity')::numeric,
      'write_offs', v_write_off_id, p_operator_id, p_reason
    );
  end loop;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (p_operator_id, 'WRITE_OFF_CREATED', 'write_offs', v_write_off_id::text,
          jsonb_build_object('reason', p_reason, 'document_no', p_document_no));

  return v_write_off_id;
end;
$$;

revoke all on function create_write_off(uuid, uuid, uuid, text, text, text, jsonb) from public;
grant execute on function create_write_off(uuid, uuid, uuid, text, text, text, jsonb) to authenticated;
