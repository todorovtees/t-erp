-- ============================================================================
-- T-ERP  |  0024_document_series.sql
-- Distinct document types (invoice, warranty card, protocol, delivery note,
-- stock receipt...) each with their own sequential numbering series (spec
-- §30-31, Aton "вградени типове печат"). issue_document_number() locks the
-- series row (same FOR UPDATE pattern as apply_stock_movement) so two
-- simultaneous prints can never get the same number, and logs every issued
-- number for audit/reprint lookup.
-- ============================================================================

create table document_number_series (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  doc_type     text not null,  -- 'invoice','proforma','warranty','protocol','delivery_note','receipt','inventory_list'
  prefix       text not null default '',
  next_number  int not null default 1,
  padding      int not null default 6,
  created_at   timestamptz not null default now(),
  unique (company_id, doc_type)
);

create table printed_documents (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id),
  doc_type         text not null,
  formatted_number text not null,
  ref_table        text,
  ref_id           uuid,
  operator_id      uuid references app_users(id),
  created_at       timestamptz not null default now()
);

create index idx_printed_documents_ref on printed_documents(ref_table, ref_id);

alter table document_number_series enable row level security;
alter table printed_documents enable row level security;

create policy document_number_series_read on document_number_series for select using (company_id = auth_company_id());
create policy printed_documents_read on printed_documents for select using (company_id = auth_company_id());
-- Writes only through issue_document_number() below.

create or replace function issue_document_number(
  p_company_id  uuid,
  p_doc_type    text,
  p_ref_table   text default null,
  p_ref_id      uuid default null,
  p_operator_id uuid default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_series document_number_series%rowtype;
  v_number text;
begin
  if p_company_id <> auth_company_id() then
    raise exception 'FORBIDDEN_COMPANY_MISMATCH' using errcode = '42501';
  end if;

  insert into document_number_series (company_id, doc_type)
  values (p_company_id, p_doc_type)
  on conflict (company_id, doc_type) do nothing;

  select * into v_series from document_number_series
  where company_id = p_company_id and doc_type = p_doc_type
  for update;

  v_number := v_series.prefix || lpad(v_series.next_number::text, v_series.padding, '0');

  update document_number_series set next_number = next_number + 1 where id = v_series.id;

  insert into printed_documents (company_id, doc_type, formatted_number, ref_table, ref_id, operator_id)
  values (p_company_id, p_doc_type, v_number, p_ref_table, p_ref_id, p_operator_id);

  return v_number;
end;
$$;

revoke all on function issue_document_number(uuid, text, text, uuid, uuid) from public;
grant execute on function issue_document_number(uuid, text, text, uuid, uuid) to authenticated;

-- Custom print templates (spec §31: placeholders like {{customer.name}}).
create table print_templates (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  doc_type   text not null,
  name       text not null,
  body       text not null,   -- HTML with {{placeholder}} tokens, interpolated client-side
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, doc_type, name)
);

alter table print_templates enable row level security;
create policy print_templates_read on print_templates for select using (company_id = auth_company_id());
create policy print_templates_write on print_templates for insert
  with check (company_id = auth_company_id() and has_permission('settings', 'edit'));
create policy print_templates_update on print_templates for update
  using (company_id = auth_company_id() and has_permission('settings', 'edit'));
create policy print_templates_delete on print_templates for delete
  using (company_id = auth_company_id() and has_permission('settings', 'full'));
