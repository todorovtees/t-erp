-- ============================================================================
-- T-ERP  |  0007_inventory_view_pricing.sql
-- Adds effective sale price + VAT rate to v_inventory_detail so the POS page
-- can search-and-price in a single query (variant.sale_price overrides
-- product.sale_price when set, matching the "variants can have their own
-- price" rule from the product spec).
-- ============================================================================

create or replace view v_inventory_detail
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
  end as stock_status,
  -- Appended after the original 0004 columns on purpose: Postgres's
  -- CREATE OR REPLACE VIEW only allows adding columns at the end, not
  -- inserting them between existing ones (it errors on the implied rename).
  coalesce(v.sale_price, p.sale_price) as sale_price,
  p.vat_rate,
  p.unit
from inventory inv
join product_variants v on v.id = inv.variant_id
join products p on p.id = v.product_id
join warehouses w on w.id = inv.warehouse_id;

grant select on v_inventory_detail to authenticated;
