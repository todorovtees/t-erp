-- ============================================================================
-- T-ERP  |  0016_price_lists.sql
-- Price lists + individual customer pricing (spec §14-15). Deliberately
-- doesn't touch complete_sale()'s tested signature — the client resolves the
-- right price via resolve_price() when building the cart (e.g. as soon as a
-- customer is selected in POS) and still passes an explicit unit_price into
-- complete_sale(), same as before. Keeps the well-tested sale core
-- unchanged; pricing logic lives in one place instead of being duplicated
-- client + server side.
-- ============================================================================

create table price_lists (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name       text not null,
  currency   text not null default 'EUR',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table price_list_items (
  id             uuid primary key default gen_random_uuid(),
  price_list_id  uuid not null references price_lists(id) on delete cascade,
  variant_id     uuid not null references product_variants(id),
  price          numeric(18,4) not null,
  min_quantity   numeric(18,3) not null default 1,
  valid_from     date,
  valid_to       date,
  unique (price_list_id, variant_id, min_quantity)
);

alter table customers add column if not exists price_list_id uuid references price_lists(id);

alter table price_lists enable row level security;
alter table price_list_items enable row level security;

create policy price_lists_read on price_lists for select using (company_id = auth_company_id());
create policy price_lists_write on price_lists for insert
  with check (company_id = auth_company_id() and has_permission('sales', 'full'));
create policy price_lists_update on price_lists for update
  using (company_id = auth_company_id() and has_permission('sales', 'full'));

create policy price_list_items_read on price_list_items for select
  using (price_list_id in (select id from price_lists where company_id = auth_company_id()));
create policy price_list_items_write on price_list_items for insert
  with check (
    has_permission('sales', 'full')
    and price_list_id in (select id from price_lists where company_id = auth_company_id())
  );
create policy price_list_items_delete on price_list_items for delete
  using (
    has_permission('sales', 'full')
    and price_list_id in (select id from price_lists where company_id = auth_company_id())
  );

-- ----------------------------------------------------------------------------
-- resolve_price() — the single place pricing logic lives. Picks the best
-- matching price-list tier (highest min_quantity at or below the requested
-- quantity, within any validity window), falling back to the product/
-- variant default. SECURITY DEFINER for convenience, but explicitly checks
-- the variant belongs to the caller's own company first (same IDOR-defense
-- pattern as every other SECURITY DEFINER function here).
-- ----------------------------------------------------------------------------

create or replace function resolve_price(
  p_variant_id  uuid,
  p_customer_id uuid default null,
  p_quantity    numeric default 1
) returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_price_list_id uuid;
  v_price         numeric;
  v_default       numeric;
begin
  if not exists (
    select 1 from product_variants v join products p on p.id = v.product_id
    where v.id = p_variant_id and p.company_id = auth_company_id()
  ) then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;

  if p_customer_id is not null then
    select price_list_id into v_price_list_id
    from customers where id = p_customer_id and company_id = auth_company_id();
  end if;

  if v_price_list_id is not null then
    select price into v_price
    from price_list_items
    where price_list_id = v_price_list_id
      and variant_id = p_variant_id
      and min_quantity <= p_quantity
      and (valid_from is null or valid_from <= current_date)
      and (valid_to is null or valid_to >= current_date)
    order by min_quantity desc
    limit 1;

    if v_price is not null then
      return v_price;
    end if;
  end if;

  select coalesce(v.sale_price, p.sale_price) into v_default
  from product_variants v join products p on p.id = v.product_id
  where v.id = p_variant_id;

  return v_default;
end;
$$;

revoke all on function resolve_price(uuid, uuid, numeric) from public;
grant execute on function resolve_price(uuid, uuid, numeric) to authenticated;
