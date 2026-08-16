-- ============================================================================
-- T-ERP  |  0009_void_sale.sql
-- A completed sale is a financial document with an audit trail — hard-
-- deleting it (or letting anyone silently edit its totals) would break the
-- integrity guarantees the rest of the schema exists to protect (spec §40:
-- the audit log itself can't be erased by a standard admin; §48-49 financial
-- integrity). The correct real-world equivalent of "delete this sale" is
-- voiding it: stock goes back, the document is marked cancelled, and the
-- fact that it happened stays in the audit log. This mirrors how real POS/
-- accounting systems handle it.
--
-- Requires 'sales' FULL permission (not just 'edit') — creating a sale and
-- voiding one are different levels of trust; see role_permissions in 0003.
-- ============================================================================

create or replace function void_sale(
  p_company_id  uuid,
  p_sale_id     uuid,
  p_operator_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale  sales%rowtype;
  v_item  record;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('sales', 'full') then
    raise exception 'FORBIDDEN: voiding a sale requires full sales permission' using errcode = '42501';
  end if;
  if p_operator_id <> auth.uid() then
    raise exception 'FORBIDDEN: operator_id must match the calling user' using errcode = '42501';
  end if;

  select * into v_sale from sales where id = p_sale_id and company_id = p_company_id;
  if not found then
    raise exception 'SALE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_sale.status = 'cancelled' then
    raise exception 'ALREADY_CANCELLED';
  end if;

  for v_item in select variant_id, quantity from sale_items where sale_id = p_sale_id loop
    perform apply_stock_movement(
      p_company_id, v_sale.warehouse_id, v_item.variant_id,
      'return_in', v_item.quantity,     -- positive: stock comes back
      'sales', p_sale_id, p_operator_id, 'Void: sale reversed'
    );
  end loop;

  update sales set status = 'cancelled' where id = p_sale_id;

  insert into audit_log (user_id, action, target_table, target_id, old_value, new_value)
  values (
    p_operator_id, 'SALE_VOIDED', 'sales', p_sale_id::text,
    jsonb_build_object('status', v_sale.status),
    jsonb_build_object('status', 'cancelled')
  );
end;
$$;

revoke all on function void_sale(uuid, uuid, uuid) from public;
grant execute on function void_sale(uuid, uuid, uuid) to authenticated;
