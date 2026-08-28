-- ============================================================================
-- T-ERP  |  0032_safe_product_delete.sql
-- "Изтрий продукт" hit a raw foreign-key error whenever the product had ever
-- touched a warehouse. That error was the database correctly protecting the
-- audit trail — but it's a terrible thing to show a user, and the UI
-- shouldn't offer an action that can't work.
--
-- The distinction that matters:
--   * inventory rows are BOOKKEEPING — a row exists the moment a product is
--     stocked anywhere, and lingers at on_hand = 0 forever after. Deleting a
--     zero-quantity inventory row loses nothing.
--   * sale_items / purchase_items / stock_movements / returns / counts are
--     HISTORY. Deleting those would corrupt financial records and the audit
--     log. They must always block deletion (spec §40, §47-49).
--
-- So: delete_product() removes the product only when no history exists
-- (clearing empty inventory rows on the way), and otherwise deactivates it
-- and returns a clear explanation of what is holding it.
-- ============================================================================

create or replace function delete_product(p_company_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant_ids uuid[];
  v_sales       int;
  v_purchases   int;
  v_movements   int;
  v_batches     int;
  v_serials     int;
  v_orders      int;
  v_returns     int;
  v_stock       numeric;
  v_blockers    text[] := '{}';
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('products', 'full') then
    raise exception 'FORBIDDEN: deleting a product requires full products permission' using errcode = '42501';
  end if;

  if not exists (select 1 from products where id = p_product_id and company_id = p_company_id) then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select array_agg(id) into v_variant_ids from product_variants where product_id = p_product_id;
  v_variant_ids := coalesce(v_variant_ids, '{}');

  -- Any stock still physically on hand? Deleting would silently lose it.
  select coalesce(sum(on_hand), 0) into v_stock
  from inventory where variant_id = any(v_variant_ids);

  select count(*) into v_sales     from sale_items          where variant_id = any(v_variant_ids);
  select count(*) into v_purchases from purchase_items      where variant_id = any(v_variant_ids);
  select count(*) into v_movements from stock_movements     where variant_id = any(v_variant_ids);
  select count(*) into v_batches   from batches             where variant_id = any(v_variant_ids);
  select count(*) into v_serials   from serial_numbers      where variant_id = any(v_variant_ids);
  select count(*) into v_orders    from customer_order_items where variant_id = any(v_variant_ids);
  select count(*) into v_returns   from customer_return_items where variant_id = any(v_variant_ids);

  if v_stock > 0      then v_blockers := v_blockers || format('налична стока (%s бр.)', v_stock); end if;
  if v_sales > 0      then v_blockers := v_blockers || format('%s продажби', v_sales); end if;
  if v_purchases > 0  then v_blockers := v_blockers || format('%s доставки', v_purchases); end if;
  if v_movements > 0  then v_blockers := v_blockers || format('%s складови движения', v_movements); end if;
  if v_batches > 0    then v_blockers := v_blockers || format('%s партиди', v_batches); end if;
  if v_serials > 0    then v_blockers := v_blockers || format('%s серийни номера', v_serials); end if;
  if v_orders > 0     then v_blockers := v_blockers || format('%s поръчки', v_orders); end if;
  if v_returns > 0    then v_blockers := v_blockers || format('%s връщания', v_returns); end if;

  -- History exists: deactivate instead of destroying records.
  if array_length(v_blockers, 1) > 0 then
    update products set is_active = false where id = p_product_id;
    update product_variants set is_active = false where product_id = p_product_id;

    insert into audit_log (user_id, action, target_table, target_id, new_value)
    values (auth.uid(), 'PRODUCT_DEACTIVATED', 'products', p_product_id::text,
            jsonb_build_object('reason', 'has history', 'blockers', v_blockers));

    return jsonb_build_object(
      'deleted', false,
      'deactivated', true,
      'blockers', v_blockers
    );
  end if;

  -- Clean: no history at all. Remove the leftover empty inventory rows
  -- (and price-list entries, which are configuration rather than history),
  -- then delete. barcodes/variants/unit_conversions cascade automatically.
  delete from inventory        where variant_id = any(v_variant_ids);
  delete from price_list_items where variant_id = any(v_variant_ids);

  delete from products where id = p_product_id;

  insert into audit_log (user_id, action, target_table, target_id, new_value)
  values (auth.uid(), 'PRODUCT_DELETED', 'products', p_product_id::text,
          jsonb_build_object('had_history', false));

  return jsonb_build_object('deleted', true, 'deactivated', false, 'blockers', '[]'::jsonb);
end;
$$;

revoke all on function delete_product(uuid, uuid) from public;
grant execute on function delete_product(uuid, uuid) to authenticated;

-- Same problem, same fix, for warehouses: the Warehouses page intentionally
-- only offers deactivation today, but this makes the rule explicit and
-- reusable if a delete button is ever added there.
create or replace function delete_warehouse(p_company_id uuid, p_warehouse_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_movements int;
  v_stock     numeric;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('warehouses', 'full') then
    raise exception 'FORBIDDEN: deleting a warehouse requires full warehouses permission' using errcode = '42501';
  end if;

  select count(*) into v_movements from stock_movements where warehouse_id = p_warehouse_id;
  select coalesce(sum(on_hand), 0) into v_stock from inventory where warehouse_id = p_warehouse_id;

  if v_movements > 0 or v_stock > 0 then
    update warehouses set status = 'inactive' where id = p_warehouse_id and company_id = p_company_id;
    return jsonb_build_object('deleted', false, 'deactivated', true,
      'blockers', to_jsonb(array[format('%s движения, %s бр. наличност', v_movements, v_stock)]));
  end if;

  delete from inventory where warehouse_id = p_warehouse_id;
  delete from warehouses where id = p_warehouse_id and company_id = p_company_id;

  return jsonb_build_object('deleted', true, 'deactivated', false, 'blockers', '[]'::jsonb);
end;
$$;

revoke all on function delete_warehouse(uuid, uuid) from public;
grant execute on function delete_warehouse(uuid, uuid) to authenticated;
