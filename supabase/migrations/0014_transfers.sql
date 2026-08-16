-- ============================================================================
-- T-ERP  |  0014_transfers.sql
-- Warehouse-to-warehouse transfers (spec §8). Stock changes according to
-- status, exactly as the spec describes: creating a transfer moves nothing;
-- sending it decrements the source warehouse; receiving it increments the
-- destination. Same SECURITY DEFINER + apply_stock_movement() pattern as
-- every other stock-moving flow in this schema.
-- ============================================================================

create table transfers (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id),
  document_no       text not null,
  from_warehouse_id uuid not null references warehouses(id),
  to_warehouse_id   uuid not null references warehouses(id),
  operator_id       uuid references app_users(id),
  status            document_status not null default 'draft',
  note              text,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  received_at       timestamptz,
  unique (company_id, document_no),
  check (from_warehouse_id <> to_warehouse_id)
);

create table transfer_items (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references transfers(id) on delete cascade,
  variant_id  uuid not null references product_variants(id),
  quantity    numeric(18,3) not null check (quantity > 0)
);

alter table transfers enable row level security;
alter table transfer_items enable row level security;

create policy transfers_read on transfers for select using (company_id = auth_company_id());
create policy transfer_items_read on transfer_items for select
  using (transfer_id in (select id from transfers where company_id = auth_company_id()));
-- Writes only through the RPCs below — draft creation still goes through
-- create_transfer() rather than a raw INSERT policy, so item rows and the
-- header always land together.

create view v_transfers_list
with (security_invoker = true)
as
select
  t.id, t.company_id, t.document_no, t.status, t.note, t.created_at, t.sent_at, t.received_at,
  wf.name as from_warehouse_name, wt.name as to_warehouse_name,
  u.full_name as operator_name,
  (select count(*) from transfer_items ti where ti.transfer_id = t.id) as item_count
from transfers t
join warehouses wf on wf.id = t.from_warehouse_id
join warehouses wt on wt.id = t.to_warehouse_id
left join app_users u on u.id = t.operator_id;

grant select on v_transfers_list to authenticated;

-- ----------------------------------------------------------------------------
-- create_transfer() — draft only, no stock movement yet.
-- ----------------------------------------------------------------------------

create or replace function create_transfer(
  p_company_id        uuid,
  p_from_warehouse_id uuid,
  p_to_warehouse_id   uuid,
  p_operator_id       uuid,
  p_document_no       text,
  p_note              text,
  p_items             jsonb   -- [{variant_id, quantity}]
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer_id uuid;
  v_item        jsonb;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('warehouses', 'edit') then
    raise exception 'FORBIDDEN: missing warehouses edit permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;
  if p_from_warehouse_id = p_to_warehouse_id then
    raise exception 'INVALID_TRANSFER: source and destination warehouse must differ';
  end if;

  insert into transfers (company_id, document_no, from_warehouse_id, to_warehouse_id, operator_id, status, note)
  values (p_company_id, p_document_no, p_from_warehouse_id, p_to_warehouse_id, p_operator_id, 'draft', p_note)
  returning id into v_transfer_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into transfer_items (transfer_id, variant_id, quantity)
    values (v_transfer_id, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric);
  end loop;

  return v_transfer_id;
end;
$$;

revoke all on function create_transfer(uuid,uuid,uuid,uuid,text,text,jsonb) from public;
grant execute on function create_transfer(uuid,uuid,uuid,uuid,text,text,jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- send_transfer() — draft -> sent, decrements the source warehouse now
-- (goods have physically left), same oversell protection as a sale.
-- ----------------------------------------------------------------------------

create or replace function send_transfer(p_company_id uuid, p_transfer_id uuid, p_operator_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer transfers%rowtype;
  v_item     record;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('warehouses', 'edit') then
    raise exception 'FORBIDDEN: missing warehouses edit permission' using errcode = '42501';
  end if;

  select * into v_transfer from transfers where id = p_transfer_id and company_id = p_company_id;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_transfer.status <> 'draft' then raise exception 'INVALID_STATUS: transfer must be draft to send'; end if;

  for v_item in select variant_id, quantity from transfer_items where transfer_id = p_transfer_id loop
    perform apply_stock_movement(
      p_company_id, v_transfer.from_warehouse_id, v_item.variant_id,
      'transfer_out', -v_item.quantity,
      'transfers', p_transfer_id, p_operator_id, 'Transfer sent'
    );
  end loop;

  update transfers set status = 'sent', sent_at = now() where id = p_transfer_id;
end;
$$;

revoke all on function send_transfer(uuid, uuid, uuid) from public;
grant execute on function send_transfer(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- receive_transfer() — sent -> received, increments the destination.
-- ----------------------------------------------------------------------------

create or replace function receive_transfer(p_company_id uuid, p_transfer_id uuid, p_operator_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer transfers%rowtype;
  v_item     record;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('warehouses', 'edit') then
    raise exception 'FORBIDDEN: missing warehouses edit permission' using errcode = '42501';
  end if;

  select * into v_transfer from transfers where id = p_transfer_id and company_id = p_company_id;
  if not found then raise exception 'TRANSFER_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_transfer.status <> 'sent' then raise exception 'INVALID_STATUS: transfer must be sent to receive'; end if;

  for v_item in select variant_id, quantity from transfer_items where transfer_id = p_transfer_id loop
    perform apply_stock_movement(
      p_company_id, v_transfer.to_warehouse_id, v_item.variant_id,
      'transfer_in', v_item.quantity,
      'transfers', p_transfer_id, p_operator_id, 'Transfer received'
    );
  end loop;

  update transfers set status = 'received', received_at = now() where id = p_transfer_id;
end;
$$;

revoke all on function receive_transfer(uuid, uuid, uuid) from public;
grant execute on function receive_transfer(uuid, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- cancel_transfer() — only while still draft (nothing has moved yet).
-- ----------------------------------------------------------------------------

create or replace function cancel_transfer(p_company_id uuid, p_transfer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('warehouses', 'edit') then
    raise exception 'FORBIDDEN: missing warehouses edit permission' using errcode = '42501';
  end if;

  update transfers set status = 'cancelled'
  where id = p_transfer_id and company_id = p_company_id and status = 'draft';

  if not found then
    raise exception 'INVALID_STATUS: only a draft transfer can be cancelled directly';
  end if;
end;
$$;

revoke all on function cancel_transfer(uuid, uuid) from public;
grant execute on function cancel_transfer(uuid, uuid) to authenticated;
