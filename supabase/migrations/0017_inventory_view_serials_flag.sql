-- ============================================================================
-- T-ERP  |  0017_inventory_view_serials_flag.sql
-- POS needs to know per-line whether a product requires serial capture.
-- Appended at the end again, same CREATE OR REPLACE VIEW column-order rule
-- as 0007.
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
  coalesce(v.sale_price, p.sale_price) as sale_price,
  p.vat_rate,
  p.unit,
  p.track_serials
from inventory inv
join product_variants v on v.id = inv.variant_id
join products p on p.id = v.product_id
join warehouses w on w.id = inv.warehouse_id;

grant select on v_inventory_detail to authenticated;
