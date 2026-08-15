-- ============================================================================
-- T-ERP  |  seed/seed_demo.sql
-- Demo/dev data — run manually in the Supabase SQL editor AFTER migrations.
-- NOT part of the migrations/ folder on purpose (spec §71: demo data must
-- stay clearly separate from schema/production data, and never runs
-- automatically on deploy).
--
-- This runs as the `postgres` role (table owner), which bypasses RLS by
-- default — that's expected for seeding, and why inventory rows are written
-- directly here instead of through apply_stock_movement() (which requires a
-- real authenticated session / auth.uid()).
--
-- After running this, create your first login user (see README §"First
-- user"), then attach it to the seeded company with:
--   insert into app_users (id, company_id, full_name, username, role)
--   values ('<auth-user-uuid>', (select id from companies where eik = 'DEMO-EIK'), 'Your Name', 'you', 'admin');
-- ============================================================================

do $$
declare
  v_company_id     uuid;
  v_wh_central     uuid;
  v_wh_sofia       uuid;
  v_wh_plovdiv     uuid;
  v_wh_online      uuid;
  v_cat_tshirts    uuid;
  v_cat_hoodies    uuid;
  v_cat_caps       uuid;
  v_brand_id       uuid;
  v_product_id     uuid;
  v_variant_id     uuid;
  v_color          text;
  v_size           text;
  v_sku            text;
  v_barcode_seq    bigint := 1000000000000; -- fake EAN13-shaped sequence
begin
  -- 1. Company -----------------------------------------------------------
  insert into companies (name, eik, vat_number, address, base_currency)
  values ('Todorov Tees Ltd', 'DEMO-EIK', 'BG000000000', 'Sofia, Bulgaria', 'EUR')
  returning id into v_company_id;

  -- 2. Warehouses (spec §67) ----------------------------------------------
  insert into warehouses (company_id, code, name, address, status) values
    (v_company_id, 'CTRL', 'Central Warehouse', 'Sofia, Industrial Zone', 'active')
    returning id into v_wh_central;
  insert into warehouses (company_id, code, name, address, status) values
    (v_company_id, 'STR-SOF', 'Store Sofia', 'Vitosha Blvd 1, Sofia', 'active')
    returning id into v_wh_sofia;
  insert into warehouses (company_id, code, name, address, status) values
    (v_company_id, 'STR-PLV', 'Store Plovdiv', 'Main St 1, Plovdiv', 'active')
    returning id into v_wh_plovdiv;
  insert into warehouses (company_id, code, name, address, status) values
    (v_company_id, 'ONLINE', 'Online Warehouse', 'Fulfilment - Sofia', 'active')
    returning id into v_wh_online;

  -- 3. Categories / brand ---------------------------------------------------
  insert into categories (company_id, name) values (v_company_id, 'T-Shirts') returning id into v_cat_tshirts;
  insert into categories (company_id, name) values (v_company_id, 'Hoodies') returning id into v_cat_hoodies;
  insert into categories (company_id, name) values (v_company_id, 'Caps') returning id into v_cat_caps;
  insert into brands (company_id, name) values (v_company_id, 'Todorov Tees') returning id into v_brand_id;

  -- 4. Product: Core T-Shirt, 3 colors x 4 sizes = 12 variants -------------
  insert into products (company_id, sku, name, description, category_id, brand_id, unit,
                         purchase_price, sale_price, vat_rate, min_stock, max_stock, is_active)
  values (v_company_id, 'TT-CORE', 'Todorov Tees Core T-Shirt', '100% combed cotton, 180g/m2',
          v_cat_tshirts, v_brand_id, 'pcs', 8.50, 24.90, 20.00, 20, 500, true)
  returning id into v_product_id;

  foreach v_color in array array['BLK','WHT','GRY'] loop
    foreach v_size in array array['S','M','L','XL'] loop
      v_sku := 'TT-CORE-' || v_color || '-' || v_size;
      insert into product_variants (product_id, sku, color, size, is_active)
      values (v_product_id, v_sku,
              case v_color when 'BLK' then 'Black' when 'WHT' then 'White' else 'Grey' end,
              v_size, true)
      returning id into v_variant_id;

      v_barcode_seq := v_barcode_seq + 1;
      insert into barcodes (variant_id, barcode, type, is_primary)
      values (v_variant_id, v_barcode_seq::text, 'EAN13', true);

      -- Starting stock: mostly in Central, a little in each store.
      insert into inventory (warehouse_id, variant_id, on_hand, reserved) values
        (v_wh_central, v_variant_id, 40, 0),
        (v_wh_sofia, v_variant_id, 8, 0),
        (v_wh_plovdiv, v_variant_id, 5, 0),
        (v_wh_online, v_variant_id, 15, 0);

      insert into stock_movements (company_id, warehouse_id, variant_id, type, quantity, ref_table, note)
      values (v_company_id, v_wh_central, v_variant_id, 'adjustment', 40, 'seed', 'Initial demo stock');
    end loop;
  end loop;

  -- 5. Product: Signature Hoodie, 2 colors x 4 sizes = 8 variants -----------
  insert into products (company_id, sku, name, description, category_id, brand_id, unit,
                         purchase_price, sale_price, vat_rate, min_stock, max_stock, is_active)
  values (v_company_id, 'TT-HOOD', 'Todorov Tees Signature Hoodie', 'Heavyweight fleece, kangaroo pocket',
          v_cat_hoodies, v_brand_id, 'pcs', 22.00, 64.90, 20.00, 10, 200, true)
  returning id into v_product_id;

  foreach v_color in array array['BLK','CHR'] loop
    foreach v_size in array array['S','M','L','XL'] loop
      v_sku := 'TT-HOOD-' || v_color || '-' || v_size;
      insert into product_variants (product_id, sku, color, size, is_active)
      values (v_product_id, v_sku, case v_color when 'BLK' then 'Black' else 'Charcoal' end, v_size, true)
      returning id into v_variant_id;

      v_barcode_seq := v_barcode_seq + 1;
      insert into barcodes (variant_id, barcode, type, is_primary)
      values (v_variant_id, v_barcode_seq::text, 'EAN13', true);

      insert into inventory (warehouse_id, variant_id, on_hand, reserved) values
        (v_wh_central, v_variant_id, 15, 0),
        (v_wh_sofia, v_variant_id, 3, 0),
        (v_wh_online, v_variant_id, 6, 0);

      insert into stock_movements (company_id, warehouse_id, variant_id, type, quantity, ref_table, note)
      values (v_company_id, v_wh_central, v_variant_id, 'adjustment', 15, 'seed', 'Initial demo stock');
    end loop;
  end loop;

  -- 6. Product: Logo Cap, one size, 2 colors --------------------------------
  insert into products (company_id, sku, name, category_id, brand_id, unit,
                         purchase_price, sale_price, vat_rate, min_stock, max_stock, is_active)
  values (v_company_id, 'TT-CAP', 'Todorov Tees Logo Cap', v_cat_caps, v_brand_id, 'pcs',
          5.00, 19.90, 20.00, 15, 150, true)
  returning id into v_product_id;

  foreach v_color in array array['BLK','WHT'] loop
    v_sku := 'TT-CAP-' || v_color;
    insert into product_variants (product_id, sku, color, is_active)
    values (v_product_id, v_sku, case v_color when 'BLK' then 'Black' else 'White' end, true)
    returning id into v_variant_id;

    v_barcode_seq := v_barcode_seq + 1;
    insert into barcodes (variant_id, barcode, type, is_primary)
    values (v_variant_id, v_barcode_seq::text, 'EAN13', true);

    -- Intentionally low, to demonstrate the "low stock" indicator (§59).
    insert into inventory (warehouse_id, variant_id, on_hand, reserved) values
      (v_wh_central, v_variant_id, 4, 0);

    insert into stock_movements (company_id, warehouse_id, variant_id, type, quantity, ref_table, note)
    values (v_company_id, v_wh_central, v_variant_id, 'adjustment', 4, 'seed', 'Initial demo stock (intentionally low)');
  end loop;

  -- 7. Customers -------------------------------------------------------------
  insert into customers (company_id, name, company_name, phone, email, credit_limit, currency) values
    (v_company_id, 'Ivan Petrov', null, '+359888000001', 'ivan@example.com', 0, 'EUR'),
    (v_company_id, 'Retail Buyer', null, '+359888000002', 'retail@example.com', 0, 'EUR'),
    (v_company_id, 'Sofia Streetwear OOD', 'Sofia Streetwear OOD', '+359888000003', 'orders@sofiastreetwear.bg', 2000, 'EUR');

  -- 8. Suppliers ---------------------------------------------------------------
  insert into suppliers (company_id, name, phone, email) values
    (v_company_id, 'Cotton Mills Textiles Ltd', '+359888100001', 'sales@cottonmills.example'),
    (v_company_id, 'Print & Press Studio', '+359888100002', 'hello@printpress.example');

  raise notice 'Seed complete. company_id = %', v_company_id;
end $$;
