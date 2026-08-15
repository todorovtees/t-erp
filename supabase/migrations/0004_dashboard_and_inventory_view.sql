-- ============================================================================
-- T-ERP  |  0004_dashboard_and_inventory_view.sql
-- Dashboard KPI aggregation + a reusable inventory-detail view.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. get_dashboard_kpis(company_id) — one round trip for the whole Dashboard.
--    SECURITY DEFINER purely for query convenience (cross-table aggregates);
--    it still manually enforces the company boundary, so it grants no more
--    access than the caller already has via the read policies.
-- ----------------------------------------------------------------------------

create or replace function get_dashboard_kpis(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'revenue_today', coalesce((
      select sum(total) from sales
      where company_id = p_company_id and created_at::date = current_date and status <> 'cancelled'
    ), 0),
    'revenue_month', coalesce((
      select sum(total) from sales
      where company_id = p_company_id
        and date_trunc('month', created_at) = date_trunc('month', now())
        and status <> 'cancelled'
    ), 0),
    'orders_today', coalesce((
      select count(*) from sales
      where company_id = p_company_id and created_at::date = current_date and status <> 'cancelled'
    ), 0),
    'purchases_month', coalesce((
      select sum(total) from purchases
      where company_id = p_company_id and date_trunc('month', created_at) = date_trunc('month', now())
    ), 0),
    'low_stock_count', (
      select count(*) from inventory inv
      join product_variants v on v.id = inv.variant_id
      join products p on p.id = v.product_id
      where p.company_id = p_company_id and inv.on_hand <= p.min_stock
    ),
    'sales_by_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'total', coalesce(s.total, 0)) order by d.day), '[]'::jsonb)
      from generate_series(current_date - interval '13 days', current_date, interval '1 day') as d(day)
      left join (
        select created_at::date as day, sum(total) as total
        from sales
        where company_id = p_company_id and status <> 'cancelled'
          and created_at >= current_date - interval '13 days'
        group by created_at::date
      ) s on s.day = d.day::date
    ),
    'top_products_month', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select p.name, sum(si.line_total) as revenue, sum(si.quantity) as qty
        from sale_items si
        join sales s on s.id = si.sale_id
        join product_variants v on v.id = si.variant_id
        join products p on p.id = v.product_id
        where s.company_id = p_company_id
          and date_trunc('month', s.created_at) = date_trunc('month', now())
          and s.status <> 'cancelled'
        group by p.id, p.name
        order by revenue desc
        limit 5
      ) t
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function get_dashboard_kpis(uuid) from public;
grant execute on function get_dashboard_kpis(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. v_inventory_detail — flat, queryable inventory view for the Inventory
--    page (spec §59: product/SKU/barcode/warehouse/on-hand/reserved/
--    available/min/max + a stock status the UI can color-code).
--    security_invoker = true is REQUIRED: without it, a view runs with the
--    view owner's bypass-RLS privileges instead of the querying user's — a
--    well-known Postgres/Supabase RLS pitfall.
-- ----------------------------------------------------------------------------

create view v_inventory_detail
with (security_invoker = true)
as
select
  p.company_id,
  p.id            as product_id,
  p.name          as product_name,
  v.id            as variant_id,
  v.sku,
  v.color,
  v.size,
  (select barcode from barcodes b where b.variant_id = v.id and b.is_primary limit 1) as barcode,
  inv.warehouse_id,
  w.name          as warehouse_name,
  inv.on_hand,
  inv.reserved,
  (inv.on_hand - inv.reserved) as available,
  p.min_stock,
  p.max_stock,
  case
    when inv.on_hand <= 0 then 'out'
    when p.min_stock > 0 and inv.on_hand <= p.min_stock * 0.5 then 'critical'
    when inv.on_hand <= p.min_stock then 'low'
    else 'normal'
  end as stock_status
from inventory inv
join product_variants v on v.id = inv.variant_id
join products p on p.id = v.product_id
join warehouses w on w.id = inv.warehouse_id;

grant select on v_inventory_detail to authenticated;
