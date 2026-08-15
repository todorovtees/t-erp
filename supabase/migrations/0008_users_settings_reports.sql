-- ============================================================================
-- T-ERP  |  0008_users_settings_reports.sql
-- Write policies needed by the Users and Settings pages, plus a date-range
-- report aggregate for the Reports page.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. app_users — let users with 'users' full permission manage teammates'
--    role/status within their own company. A user can't be edited into a
--    different company (company_id isn't updatable via this policy's WITH
--    CHECK matching the same company on both old and new row).
-- ----------------------------------------------------------------------------

create policy app_users_update on app_users for update
  using (company_id = auth_company_id() and has_permission('users','full'))
  with check (company_id = auth_company_id());

-- ----------------------------------------------------------------------------
-- 2. companies — Settings page needs to edit the company profile.
-- ----------------------------------------------------------------------------

create policy company_update on companies for update
  using (id = auth_company_id() and has_permission('settings','edit'));

-- ----------------------------------------------------------------------------
-- 3. get_sales_report — revenue/orders grouped by day for an arbitrary date
--    range + optional warehouse filter, for the Reports page.
-- ----------------------------------------------------------------------------

create or replace function get_sales_report(
  p_company_id   uuid,
  p_date_from    date,
  p_date_to      date,
  p_warehouse_id uuid default null
) returns jsonb
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
    'total_revenue', coalesce((
      select sum(total) from sales
      where company_id = p_company_id and status <> 'cancelled'
        and created_at::date between p_date_from and p_date_to
        and (p_warehouse_id is null or warehouse_id = p_warehouse_id)
    ), 0),
    'order_count', coalesce((
      select count(*) from sales
      where company_id = p_company_id and status <> 'cancelled'
        and created_at::date between p_date_from and p_date_to
        and (p_warehouse_id is null or warehouse_id = p_warehouse_id)
    ), 0),
    'by_day', (
      select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'total', coalesce(s.total, 0), 'orders', coalesce(s.orders, 0)) order by d.day), '[]'::jsonb)
      from generate_series(p_date_from, p_date_to, interval '1 day') as d(day)
      left join (
        select created_at::date as day, sum(total) as total, count(*) as orders
        from sales
        where company_id = p_company_id and status <> 'cancelled'
          and created_at::date between p_date_from and p_date_to
          and (p_warehouse_id is null or warehouse_id = p_warehouse_id)
        group by created_at::date
      ) s on s.day = d.day::date
    ),
    'by_category', (
      select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
        select coalesce(cat.name, 'Без категория') as category, sum(si.line_total) as revenue
        from sale_items si
        join sales s on s.id = si.sale_id
        join product_variants v on v.id = si.variant_id
        join products p on p.id = v.product_id
        left join categories cat on cat.id = p.category_id
        where s.company_id = p_company_id and s.status <> 'cancelled'
          and s.created_at::date between p_date_from and p_date_to
          and (p_warehouse_id is null or s.warehouse_id = p_warehouse_id)
        group by cat.name
        order by revenue desc
      ) t
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function get_sales_report(uuid, date, date, uuid) from public;
grant execute on function get_sales_report(uuid, date, date, uuid) to authenticated;
