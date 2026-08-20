-- ============================================================================
-- T-ERP  |  0025_groups.sql
-- Customer/product groups (Aton: "индивидуални цени... към всеки клиент
-- или ГРУПА клиенти"). resolve_price() gets a fallback chain: customer's
-- own price list -> customer's group's price list -> product default.
-- ============================================================================

create table customer_groups (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  name          text not null,
  price_list_id uuid references price_lists(id),
  created_at    timestamptz not null default now(),
  unique (company_id, name)
);

alter table customers add column if not exists group_id uuid references customer_groups(id);

create table product_groups (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name       text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

alter table products add column if not exists group_id uuid references product_groups(id);

alter table customer_groups enable row level security;
alter table product_groups enable row level security;

create policy customer_groups_read on customer_groups for select using (company_id = auth_company_id());
create policy customer_groups_write on customer_groups for insert
  with check (company_id = auth_company_id() and has_permission('customers', 'edit'));
create policy customer_groups_update on customer_groups for update
  using (company_id = auth_company_id() and has_permission('customers', 'edit'));

create policy product_groups_read on product_groups for select using (company_id = auth_company_id());
create policy product_groups_write on product_groups for insert
  with check (company_id = auth_company_id() and has_permission('products', 'edit'));

-- ----------------------------------------------------------------------------
-- resolve_price() — extended fallback chain (customer list -> group list ->
-- default). Same signature as 0016, same IDOR check, same permission model.
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
  v_own_list_id   uuid;
  v_group_list_id uuid;
  v_candidate_id  uuid;
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
    select c.price_list_id, cg.price_list_id
    into v_own_list_id, v_group_list_id
    from customers c
    left join customer_groups cg on cg.id = c.group_id
    where c.id = p_customer_id and c.company_id = auth_company_id();
  end if;

  -- Try the customer's own list first, then their group's list.
  for v_candidate_id in select unnest(array[v_own_list_id, v_group_list_id]) loop
    continue when v_candidate_id is null;

    select price into v_price
    from price_list_items
    where price_list_id = v_candidate_id
      and variant_id = p_variant_id
      and min_quantity <= p_quantity
      and (valid_from is null or valid_from <= current_date)
      and (valid_to is null or valid_to >= current_date)
    order by min_quantity desc
    limit 1;

    if v_price is not null then
      return v_price;
    end if;
  end loop;

  select coalesce(v.sale_price, p.sale_price) into v_default
  from product_variants v join products p on p.id = v.product_id
  where v.id = p_variant_id;

  return v_default;
end;
$$;

revoke all on function resolve_price(uuid, uuid, numeric) from public;
grant execute on function resolve_price(uuid, uuid, numeric) to authenticated;
