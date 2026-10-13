-- Hot-path indexes and policy gaps from the database review (docs/production-readiness.md, P1).
--
-- Indexes are built without CONCURRENTLY because a migration runs in a transaction; the tables are small at
-- launch. On a large database create them concurrently by hand first (the `if not exists` then skips them).

-- ---------------------------------------------------------------------------
-- 1. Indexes for the queries the pages run
-- ---------------------------------------------------------------------------
-- The tender page lists these per tender, newest first.
create index if not exists handoffs_tender_idx on public.handoffs (tender_id, created_at desc);
create index if not exists approvals_tender_idx on public.approvals (tender_id, requested_at desc);
create index if not exists workflow_runs_tender_idx on public.workflow_runs (tender_id, created_at desc);
-- Following a task to its handoffs, and deleting a task (the foreign keys set these to null).
create index if not exists handoffs_to_task_idx on public.handoffs (to_task_id) where to_task_id is not null;
create index if not exists handoffs_from_task_idx on public.handoffs (from_task_id) where from_task_id is not null;
-- The existing unique index on task_id is partial (pending approvals only), so it cannot serve a lookup by task.
create index if not exists approvals_task_idx on public.approvals (task_id);
create index if not exists approvals_run_idx on public.approvals (workflow_run_id) where workflow_run_id is not null;
-- The tender list filters by status and sorts by closing date; the old (organisation_id, status) index is its prefix.
create index if not exists tenders_org_status_closing_idx on public.tenders (organisation_id, status, closing_at);
drop index if exists public.tenders_org_status_idx;
-- The bell lists a person's notifications, newest first.
create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Foreign keys without an index: deleting the parent row scanned the whole child table
-- ---------------------------------------------------------------------------
create index if not exists jobs_org_idx on public.jobs (organisation_id);
create index if not exists submission_records_org_idx on public.submission_records (organisation_id);
create index if not exists submission_records_approval_idx on public.submission_records (approval_id);
create index if not exists submission_records_run_idx on public.submission_records (workflow_run_id) where workflow_run_id is not null;
create index if not exists notifications_org_idx on public.notifications (organisation_id);
create index if not exists task_dependencies_depends_on_idx on public.task_dependencies (depends_on_task_id);
create index if not exists task_dependencies_org_idx on public.task_dependencies (organisation_id);
create index if not exists tasks_parent_idx on public.tasks (parent_task_id) where parent_task_id is not null;
create index if not exists tasks_approval_idx on public.tasks (approval_id) where approval_id is not null;
create index if not exists email_messages_account_idx on public.email_messages (email_account_id) where email_account_id is not null;
create index if not exists cost_usage_task_idx on public.cost_usage (task_id) where task_id is not null;
create index if not exists cost_usage_run_idx on public.cost_usage (workflow_run_id) where workflow_run_id is not null;
create index if not exists cost_usage_agent_idx on public.cost_usage (agent_id) where agent_id is not null;

-- Erasing a person (migration 051) clears every reference to them; without these each one scans its table.
create index if not exists tenders_created_by_idx on public.tenders (created_by) where created_by is not null;
create index if not exists workflow_runs_started_by_idx on public.workflow_runs (started_by) where started_by is not null;
create index if not exists approvals_decided_by_idx on public.approvals (decided_by) where decided_by is not null;
create index if not exists email_messages_sent_by_idx on public.email_messages (sent_by) where sent_by is not null;
create index if not exists email_accounts_user_idx on public.email_accounts (user_id);
create index if not exists autofill_tokens_user_idx on public.autofill_tokens (user_id);
create index if not exists company_documents_uploaded_by_idx on public.company_documents (uploaded_by) where uploaded_by is not null;
create index if not exists company_documents_verified_by_idx on public.company_documents (verified_by) where verified_by is not null;

-- ---------------------------------------------------------------------------
-- 3. Notifications follow membership
-- ---------------------------------------------------------------------------
-- A notification is the person's own, but it belongs to an organisation: someone removed from it must not
-- keep reading what it told them (and realtime applies this policy too).
drop policy "users read own notifications" on public.notifications;
create policy "users read own notifications" on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organisation_id));

-- ---------------------------------------------------------------------------
-- 4. Private functions start closed
-- ---------------------------------------------------------------------------
-- Postgres lets everyone execute a new function unless told otherwise, and migration 004 only revoked that for
-- the functions that existed then. Four later ones were left open to PUBLIC.
--
-- The schema-scoped statement below is the usual spelling but, on its own, does not remove the built-in PUBLIC
-- grant (a per-schema default can only add to the global one). The role-wide statement is what makes functions
-- created from now on closed; everything in this repo grants execute explicitly where it is needed.
alter default privileges in schema private revoke execute on functions from public;
alter default privileges revoke execute on functions from public;

revoke execute on function private.limit_tender_creation() from public, anon, authenticated;
revoke execute on function private.stamp_company_profile() from public, anon, authenticated;
-- These two run under the caller's rights (a storage policy, a check constraint), so signed-in users keep an
-- explicit grant; nobody else needs one.
revoke execute on function private.storage_path_org(text) from public, anon;
revoke execute on function private.valid_keywords(text[]) from public, anon;
grant execute on function private.storage_path_org(text) to authenticated, service_role;
grant execute on function private.valid_keywords(text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Rate limit counters are behind row level security
-- ---------------------------------------------------------------------------
-- Only SECURITY DEFINER functions owned by the table's owner (which RLS does not apply to) and the service role
-- (which bypasses it) touch this table. With no policy, every other role sees nothing.
alter table private.rate_limits enable row level security;
revoke all on private.rate_limits from anon, authenticated;
