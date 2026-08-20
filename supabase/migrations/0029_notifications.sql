-- ============================================================================
-- T-ERP  |  0029_notifications.sql
-- In-app notifications (spec §41). Real-time email/SMS delivery needs an
-- Edge Function + provider credentials (see supabase/functions/ — written
-- but requires deployment, see README); in-app notifications work fully
-- today with no extra infrastructure. Low-stock notifications fire from
-- inside apply_stock_movement() itself (the single choke point for every
-- stock change) only on the moment of CROSSING into the low zone, not on
-- every subsequent sale while already low — avoids spamming one alert per
-- unit sold.
-- ============================================================================

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  user_id    uuid references app_users(id),  -- null = visible to whole company
  type       text not null,                  -- 'low_stock','overdue_payment','new_order','count_pending_approval',...
  title      text not null,
  body       text,
  ref_table  text,
  ref_id     uuid,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_notifications_user on notifications(company_id, user_id, is_read, created_at desc);

alter table notifications enable row level security;

create policy notifications_read on notifications for select
  using (company_id = auth_company_id() and (user_id = auth.uid() or user_id is null));
create policy notifications_update on notifications for update
  using (company_id = auth_company_id() and (user_id = auth.uid() or user_id is null));
-- No client INSERT policy — notifications are only created by triggers/RPCs
-- below (SECURITY DEFINER), so a user can never spoof a notification.

create or replace function create_notification(
  p_company_id uuid, p_user_id uuid, p_type text, p_title text, p_body text,
  p_ref_table text default null, p_ref_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into notifications (company_id, user_id, type, title, body, ref_table, ref_id)
  values (p_company_id, p_user_id, p_type, p_title, p_body, p_ref_table, p_ref_id);
end;
$$;
-- Internal helper, not exposed to authenticated directly (no grant) — only
-- called from other SECURITY DEFINER functions in this file/migration set.

-- ----------------------------------------------------------------------------
-- Re-wire apply_stock_movement() to fire a low-stock notification exactly
-- once per crossing (was-above-min, now-at-or-below-min).
-- ----------------------------------------------------------------------------

create or replace function apply_stock_movement(
  p_company_id   uuid,
  p_warehouse_id uuid,
  p_variant_id   uuid,
  p_type         stock_movement_type,
  p_quantity     numeric,
  p_ref_table    text,
  p_ref_id       uuid,
  p_operator_id  uuid,
  p_note         text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current   numeric(18,3);
  v_min_stock numeric(18,3);
  v_product_name text;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('inventory','edit') then
    raise exception 'FORBIDDEN: missing inventory edit permission' using errcode = '42501';
  end if;

  insert into inventory (warehouse_id, variant_id, on_hand, reserved)
  values (p_warehouse_id, p_variant_id, 0, 0)
  on conflict (warehouse_id, variant_id) do nothing;

  select on_hand into v_current
  from inventory
  where warehouse_id = p_warehouse_id and variant_id = p_variant_id
  for update;

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

  -- Crossing detection: only fire once per dip below minimum, not on every
  -- subsequent movement while already low.
  if p_quantity < 0 then
    select p.min_stock, p.name into v_min_stock, v_product_name
    from product_variants v join products p on p.id = v.product_id
    where v.id = p_variant_id;

    if v_min_stock > 0 and v_current > v_min_stock and (v_current + p_quantity) <= v_min_stock then
      perform create_notification(
        p_company_id, null, 'low_stock',
        format('Ниска наличност: %s', v_product_name),
        format('Наличността падна на %s бр. (минимум %s бр.)', v_current + p_quantity, v_min_stock),
        'inventory', p_variant_id
      );
    end if;
  end if;
end;
$$;

revoke all on function apply_stock_movement(uuid,uuid,uuid,stock_movement_type,numeric,text,uuid,uuid,text) from public;
grant execute on function apply_stock_movement(uuid,uuid,uuid,stock_movement_type,numeric,text,uuid,uuid,text) to authenticated;

-- ----------------------------------------------------------------------------
-- notify_new_customer_order() — small, explicit trigger point (called from
-- the frontend right after create_customer_order succeeds, rather than
-- reworking that already-tested RPC).
-- ----------------------------------------------------------------------------

create or replace function notify_new_customer_order(p_company_id uuid, p_order_id uuid, p_document_no text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  perform create_notification(
    p_company_id, null, 'new_order',
    format('Нова поръчка %s', p_document_no),
    'Постъпи нова поръчка от клиент.',
    'customer_orders', p_order_id
  );
end;
$$;

revoke all on function notify_new_customer_order(uuid, uuid, text) from public;
grant execute on function notify_new_customer_order(uuid, uuid, text) to authenticated;
