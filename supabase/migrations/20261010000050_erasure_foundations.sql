-- POPIA erasure, part 1: make erasure possible without making the audit trail editable.
--
-- Problem (docs/production-readiness.md, P0 #1): the append-only trigger rejected every UPDATE as well as
-- every DELETE. `on delete set null` is an UPDATE, so deleting a user who had ever acted failed, and
-- `audit_logs.organisation_id ... on delete restrict` meant no organisation could ever be deleted.
--
-- This migration:
--   1. lets private.reject_mutation pass in exactly two cases (see the function);
--   2. makes audit_logs.organisation_id a plain uuid, so the trail outlives the organisation;
--   3. replaces the foreign keys that block deleting a user or a mailbox;
--   4. deletes a mailbox credential from Vault whenever its mailbox row goes;
--   5. rejects TRUNCATE on the append-only tables and takes the privilege away from the API roles.
-- The erasure functions themselves are in the next migration.

-- ---------------------------------------------------------------------------
-- 1. The append-only trigger
-- ---------------------------------------------------------------------------
create or replace function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Erasure and retention run inside SECURITY DEFINER functions that set this for their own
  -- transaction only (private.erase_user, private.erase_organisation, private.run_retention_purge).
  -- Nothing else sets it, and the API roles hold no UPDATE or DELETE on these tables.
  if current_setting('app.erasure', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- Deleting an account clears the actor columns through `on delete set null`, which is an UPDATE.
  -- That is allowed when clearing the actor is the only thing the statement changes.
  if tg_op = 'UPDATE'
     and (to_jsonb(old) ->> 'actor_user_id') is not null
     and (to_jsonb(new) ->> 'actor_user_id') is null
     and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;

  raise exception 'Table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

create or replace function private.reject_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.reject_truncate();
create trigger agent_events_no_truncate before truncate on public.agent_events
  for each statement execute function private.reject_truncate();
create trigger tender_status_history_no_truncate before truncate on public.tender_status_history
  for each statement execute function private.reject_truncate();
create trigger agent_status_transitions_no_truncate before truncate on public.agent_status_transitions
  for each statement execute function private.reject_truncate();
create trigger cost_usage_no_truncate before truncate on public.cost_usage
  for each statement execute function private.reject_truncate();

revoke truncate on public.audit_logs, public.agent_events, public.tender_status_history,
  public.agent_status_transitions, public.cost_usage from service_role, authenticated, anon;

revoke all on function private.reject_mutation() from public, anon, authenticated;
revoke all on function private.reject_truncate() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The audit trail outlives its organisation
-- ---------------------------------------------------------------------------
alter table public.audit_logs drop constraint audit_logs_organisation_id_fkey;
comment on column public.audit_logs.organisation_id is
  'Plain uuid on purpose: audit rows are kept (de-identified) after an organisation is erased (private.erase_organisation).';

-- ---------------------------------------------------------------------------
-- 3. Foreign keys that blocked deleting a user or a mailbox
-- ---------------------------------------------------------------------------
-- Whoever last changed an organisation's settings may leave.
alter table public.system_settings drop constraint system_settings_updated_by_fkey;
alter table public.system_settings add constraint system_settings_updated_by_fkey
  foreign key (updated_by) references auth.users (id) on delete set null;

-- A sent-email record outlives the person and the mailbox that sent it.
alter table public.email_messages alter column sent_by drop not null;
alter table public.email_messages drop constraint email_messages_sent_by_fkey;
alter table public.email_messages add constraint email_messages_sent_by_fkey
  foreign key (sent_by) references auth.users (id) on delete set null;

alter table public.email_messages alter column email_account_id drop not null;
alter table public.email_messages drop constraint email_messages_email_account_id_fkey;
alter table public.email_messages add constraint email_messages_email_account_id_fkey
  foreign key (email_account_id) references public.email_accounts (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4. A mailbox credential never outlives its mailbox row
-- ---------------------------------------------------------------------------
-- disconnect_email_account already deletes the secret, but removing a member (or an organisation, or an
-- account) deletes the mailbox row through a cascade and left the secret behind in Vault.
create or replace function private.delete_email_account_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.secret_id;
  return old;
end;
$$;
revoke all on function private.delete_email_account_secret() from public, anon, authenticated;

create trigger email_accounts_delete_secret before delete on public.email_accounts
  for each row execute function private.delete_email_account_secret();
