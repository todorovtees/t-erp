-- ============================================================================
-- T-ERP  |  0018_banks.sql
-- Unlimited bank accounts (spec's original §26, and Aton's "неограничен
-- брой Банки"). Structurally parallel to cash_registers/cash_sessions, but
-- banks need running-balance transactions rather than open/close sessions.
-- ============================================================================

create table bank_accounts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  bank_name  text not null,
  iban       text not null,
  currency   text not null default 'EUR',
  opening_balance numeric(18,2) not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, iban)
);

create table bank_transactions (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  bank_account_id uuid not null references bank_accounts(id),
  type            text not null check (type in ('deposit', 'withdrawal', 'transfer_in', 'transfer_out')),
  amount          numeric(18,2) not null check (amount > 0),
  note            text,
  ref_transaction_id uuid references bank_transactions(id), -- links the two legs of a transfer
  operator_id     uuid references app_users(id),
  created_at      timestamptz not null default now()
);

create index idx_bank_transactions_account on bank_transactions(bank_account_id, created_at desc);

alter table bank_accounts enable row level security;
alter table bank_transactions enable row level security;

create policy bank_accounts_read on bank_accounts for select using (company_id = auth_company_id());
create policy bank_accounts_write on bank_accounts for insert
  with check (company_id = auth_company_id() and has_permission('finance', 'edit'));
create policy bank_accounts_update on bank_accounts for update
  using (company_id = auth_company_id() and has_permission('finance', 'edit'));

create policy bank_transactions_read on bank_transactions for select
  using (bank_account_id in (select id from bank_accounts where company_id = auth_company_id()));
-- Writes only through record_bank_transaction()/transfer_between_banks() below.

create view v_bank_balances
with (security_invoker = true)
as
select
  ba.id, ba.company_id, ba.bank_name, ba.iban, ba.currency, ba.opening_balance, ba.is_active,
  ba.opening_balance + coalesce(sum(
    case when bt.type in ('deposit', 'transfer_in') then bt.amount
         when bt.type in ('withdrawal', 'transfer_out') then -bt.amount
         else 0 end
  ), 0) as current_balance
from bank_accounts ba
left join bank_transactions bt on bt.bank_account_id = ba.id
group by ba.id;

grant select on v_bank_balances to authenticated;

-- ----------------------------------------------------------------------------
-- record_bank_transaction() — simple deposit/withdrawal.
-- ----------------------------------------------------------------------------

create or replace function record_bank_transaction(
  p_company_id      uuid,
  p_bank_account_id uuid,
  p_type            text,
  p_amount          numeric,
  p_note            text,
  p_operator_id     uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('finance', 'edit') then
    raise exception 'FORBIDDEN: missing finance edit permission' using errcode = '42501';
  end if;
  if p_type not in ('deposit', 'withdrawal') then
    raise exception 'INVALID_TYPE: use transfer_between_banks() for transfers';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and company_id = p_company_id) then
    raise exception 'BANK_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into bank_transactions (company_id, bank_account_id, type, amount, note, operator_id)
  values (p_company_id, p_bank_account_id, p_type, p_amount, p_note, p_operator_id)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function record_bank_transaction(uuid, uuid, text, numeric, text, uuid) from public;
grant execute on function record_bank_transaction(uuid, uuid, text, numeric, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- transfer_between_banks() — two linked legs, both-or-nothing.
-- ----------------------------------------------------------------------------

create or replace function transfer_between_banks(
  p_company_id       uuid,
  p_from_account_id  uuid,
  p_to_account_id    uuid,
  p_amount           numeric,
  p_note             text,
  p_operator_id      uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out_id uuid;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;
  if not has_permission('finance', 'edit') then
    raise exception 'FORBIDDEN: missing finance edit permission' using errcode = '42501';
  end if;
  if p_from_account_id = p_to_account_id then
    raise exception 'INVALID_TRANSFER: accounts must differ';
  end if;

  insert into bank_transactions (company_id, bank_account_id, type, amount, note, operator_id)
  values (p_company_id, p_from_account_id, 'transfer_out', p_amount, p_note, p_operator_id)
  returning id into v_out_id;

  insert into bank_transactions (company_id, bank_account_id, type, amount, note, ref_transaction_id, operator_id)
  values (p_company_id, p_to_account_id, 'transfer_in', p_amount, p_note, v_out_id, p_operator_id);
end;
$$;

revoke all on function transfer_between_banks(uuid, uuid, uuid, numeric, text, uuid) from public;
grant execute on function transfer_between_banks(uuid, uuid, uuid, numeric, text, uuid) to authenticated;
