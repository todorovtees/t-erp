-- ============================================================================
-- T-ERP  |  0011_documents.sql
-- A real document library backed by Supabase Storage — the practical
-- alternative to a direct DevonThink connection (DevonThink is a local
-- macOS app with no public web API a static site could call). Files live in
-- a private 'documents' bucket, one folder per company
-- (storage path: '{company_id}/{uuid}-{filename}'), with RLS on
-- storage.objects enforcing that boundary the same way every other table
-- in this schema does. A metadata table gives the UI something normal to
-- query/filter/sort instead of listing the storage bucket directly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New permission module: 'documents'. Broader access than 'settings' —
--    everyone can at least view the library, finance-adjacent roles can
--    upload, only admins/managers can delete.
-- ----------------------------------------------------------------------------

insert into role_permissions (role, module, level, can_approve, can_export, can_print) values
  ('super_admin','documents','full',true,true,true),
  ('admin','documents','full',true,true,true),
  ('manager','documents','full',false,true,true),
  ('accountant','documents','edit',false,true,true),
  ('warehouse_operator','documents','view',false,false,true),
  ('sales_operator','documents','view',false,false,true),
  ('cashier','documents','view',false,false,false),
  ('read_only','documents','view',false,false,false)
on conflict (role, module) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Storage bucket (private — access only via RLS-checked signed requests,
--    never a public URL).
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy documents_bucket_read on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth_company_id()::text);

create policy documents_bucket_insert on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth_company_id()::text
    and has_permission('documents', 'edit')
  );

create policy documents_bucket_delete on storage.objects for delete
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth_company_id()::text
    and has_permission('documents', 'full')
  );

-- ----------------------------------------------------------------------------
-- 3. Metadata table
-- ----------------------------------------------------------------------------

create table document_files (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id),
  storage_path  text not null unique,
  filename      text not null,
  category      text not null default 'other',  -- 'invoice','contract','certificate','other', freeform
  size_bytes    bigint,
  uploaded_by   uuid references app_users(id),
  created_at    timestamptz not null default now()
);

create index idx_document_files_company on document_files(company_id, created_at desc);

alter table document_files enable row level security;

create policy document_files_read on document_files for select
  using (company_id = auth_company_id());
create policy document_files_write on document_files for insert
  with check (company_id = auth_company_id() and has_permission('documents', 'edit'));
create policy document_files_delete on document_files for delete
  using (company_id = auth_company_id() and has_permission('documents', 'full'));
