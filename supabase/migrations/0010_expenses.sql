-- ============================================================================
-- T-ERP  |  0010_expenses.sql
-- General company expense tracking (packaging, boxes, printing, chemicals,
-- anything that isn't a supplier purchase of sellable stock). Reuses the
-- existing 'finance' permission module from 0003 rather than adding a new
-- one, since expense entry is a finance-team activity.
-- ============================================================================

create table expenses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  category      text not null,             -- freeform: 'Опаковки', 'Канцеларски', 'Химикали', ...
  description   text,
  amount        numeric(18,2) not null check (amount >= 0),
  currency      text not null default 'EUR',
  supplier_id   uuid references suppliers(id),
  warehouse_id  uuid references warehouses(id),
  expense_date  date not null default current_date,
  operator_id   uuid references app_users(id),
  created_at    timestamptz not null default now()
);

create index idx_expenses_company_date on expenses(company_id, expense_date desc);

alter table expenses enable row level security;

create policy expenses_read on expenses for select
  using (company_id = auth_company_id());
create policy expenses_write on expenses for insert
  with check (company_id = auth_company_id() and has_permission('finance', 'edit'));
create policy expenses_update on expenses for update
  using (company_id = auth_company_id() and has_permission('finance', 'edit'));
create policy expenses_delete on expenses for delete
  using (company_id = auth_company_id() and has_permission('finance', 'full'));

-- Small aggregate for the Expenses page header KPIs (this month / by category).
create or replace function get_expenses_summary(
  p_company_id uuid,
  p_date_from  date,
  p_date_to    date
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
    'total', coalesce((
      select sum(amount) from expenses
      where company_id = p_company_id and expense_date between p_date_from and p_date_to
    ), 0),
    'by_category', (
      select coalesce(jsonb_agg(row_to_json(t) order by t.total desc), '[]'::jsonb) from (
        select category, sum(amount) as total
        from expenses
        where company_id = p_company_id and expense_date between p_date_from and p_date_to
        group by category
      ) t
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function get_expenses_summary(uuid, date, date) from public;
grant execute on function get_expenses_summary(uuid, date, date) to authenticated;
