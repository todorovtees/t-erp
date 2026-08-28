-- ============================================================================
-- T-ERP  |  0027_multi_currency.sql
-- Real multi-currency (spec §28, Aton "разплащане в различни видове
-- валута"). Deliberately a display/rate layer on top of the existing,
-- well-tested transactional core rather than a rewrite of complete_sale()/
-- receive_purchase() — those keep storing whatever currency code the client
-- sends (already supported since 0001/0002), and this migration adds the
-- rate table + conversion helper so the UI can show accurate base-currency
-- equivalents and let POS/Purchases pick a currency with a real, dated rate.
-- ============================================================================

create table currencies (
  code   text primary key,
  name   text not null,
  symbol text
);

insert into currencies (code, name, symbol) values
  ('EUR', 'Euro', '€'), ('USD', 'US Dollar', '$'), ('GBP', 'British Pound', '£'), ('BGN', 'Bulgarian Lev', 'лв.')
on conflict (code) do nothing;

-- This is a global lookup table (currency codes), not tenant data — every
-- company reads the same rows, so there's no company_id to scope by. RLS is
-- still enabled: without it, PostgREST would expose the table to any key
-- holder for writes as well as reads. The policy below grants read to
-- logged-in users and nothing else, so the list can only be changed through
-- a migration (or service_role), never by a client.
alter table currencies enable row level security;

create policy currencies_read on currencies for select
  to authenticated
  using (true);

create table exchange_rates (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  currency_code text not null references currencies(code),
  rate_to_base  numeric(18,6) not null check (rate_to_base > 0),
  rate_date     date not null default current_date,
  created_at    timestamptz not null default now(),
  unique (company_id, currency_code, rate_date)
);

alter table exchange_rates enable row level security;

create policy exchange_rates_read on exchange_rates for select using (company_id = auth_company_id());
create policy exchange_rates_write on exchange_rates for insert
  with check (company_id = auth_company_id() and has_permission('settings', 'edit'));

-- Latest known rate at or before a given date (falls back to 1:1 if the
-- currency IS the company's base currency, and raises clearly otherwise so
-- a document is never silently priced with the wrong rate).
create or replace function convert_to_base(
  p_company_id    uuid,
  p_amount        numeric,
  p_currency_code text,
  p_on_date       date default current_date
) returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base_currency text;
  v_rate numeric;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;

  select base_currency into v_base_currency from companies where id = p_company_id;

  if p_currency_code = v_base_currency then
    return p_amount;
  end if;

  select rate_to_base into v_rate
  from exchange_rates
  where company_id = p_company_id and currency_code = p_currency_code and rate_date <= p_on_date
  order by rate_date desc
  limit 1;

  if v_rate is null then
    raise exception 'NO_EXCHANGE_RATE: no rate on or before % for %', p_on_date, p_currency_code;
  end if;

  return round(p_amount * v_rate, 2);
end;
$$;

revoke all on function convert_to_base(uuid, numeric, text, date) from public;
grant execute on function convert_to_base(uuid, numeric, text, date) to authenticated;
