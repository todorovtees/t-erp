-- ============================================================================
-- T-ERP  |  0031_scheduling_and_invites.sql
-- Two queues that are real and functional on the database side today, but
-- need a deployed Edge Function to actually DO something with them (send an
-- email; call the Supabase Auth admin API with the service_role key, which
-- must never live in the frontend). The Edge Function code for both is in
-- supabase/functions/ — written and ready, just needs `supabase functions
-- deploy` + secrets set, which only you can do from your own Supabase
-- project. This migration is what makes those functions have something to
-- read once deployed; it's not blocked on them to be useful in the
-- meantime (e.g. you can see pending invites/schedules right away).
-- ============================================================================

create table scheduled_reports (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id),
  report_type    text not null default 'sales_summary' check (report_type in ('sales_summary', 'low_stock', 'expenses_summary')),
  cadence        text not null check (cadence in ('daily', 'weekly', 'monthly')),
  recipient_email citext not null,
  is_active      boolean not null default true,
  last_sent_at   timestamptz,
  created_by     uuid references app_users(id),
  created_at     timestamptz not null default now()
);

alter table scheduled_reports enable row level security;

create policy scheduled_reports_read on scheduled_reports for select using (company_id = auth_company_id());
create policy scheduled_reports_write on scheduled_reports for insert
  with check (company_id = auth_company_id() and has_permission('reports', 'full') and created_by = auth.uid());
create policy scheduled_reports_update on scheduled_reports for update
  using (company_id = auth_company_id() and has_permission('reports', 'full'));
create policy scheduled_reports_delete on scheduled_reports for delete
  using (company_id = auth_company_id() and has_permission('reports', 'full'));

create table user_invites (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id),
  email        citext not null,
  full_name    text not null,
  role         user_role not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'accepted', 'failed')),
  error_message text,
  requested_by uuid references app_users(id),
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);

alter table user_invites enable row level security;

create policy user_invites_read on user_invites for select using (company_id = auth_company_id());
create policy user_invites_write on user_invites for insert
  with check (company_id = auth_company_id() and has_permission('users', 'full') and requested_by = auth.uid());

-- Notify-worthy events the scheduled-reports Edge Function can poll instead
-- of re-deriving "is this due" logic in two places.
create or replace function due_scheduled_reports()
returns setof scheduled_reports
language sql
stable
security definer
set search_path = public
as $$
  select * from scheduled_reports
  where is_active
    and (
      last_sent_at is null
      or (cadence = 'daily' and last_sent_at < now() - interval '1 day')
      or (cadence = 'weekly' and last_sent_at < now() - interval '7 days')
      or (cadence = 'monthly' and last_sent_at < now() - interval '1 month')
    );
$$;
-- Intentionally no grant to `authenticated` — this is for the Edge Function,
-- which calls it with the service_role key (bypasses RLS/grants entirely,
-- same as any service_role call), not from client code.
