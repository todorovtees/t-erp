-- ============================================================================
-- T-ERP  |  0005_product_summary_view.sql
-- Flat product list view for the Products page: variant count + total stock
-- across all warehouses, so the UI doesn't need N+1 queries per row.
-- ============================================================================

create view v_product_summary
with (security_invoker = true)
as
select
  p.id,
  p.company_id,
  p.sku,
  p.name,
  p.unit,
  p.purchase_price,
  p.sale_price,
  p.vat_rate,
  p.min_stock,
  p.max_stock,
  p.is_active,
  c.name as category_name,
  b.name as brand_name,
  count(distinct v.id) as variant_count,
  coalesce(sum(inv.on_hand), 0) as total_on_hand
from products p
left join categories c on c.id = p.category_id
left join brands b on b.id = p.brand_id
left join product_variants v on v.product_id = p.id
left join inventory inv on inv.variant_id = v.id
group by p.id, c.name, b.name;

grant select on v_product_summary to authenticated;
