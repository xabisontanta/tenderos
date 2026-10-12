# Database architecture

All schema lives in `supabase/migrations/` (applied in order). Types for the
app are generated into `types/database.ts` with `npm run db:types`.

## Schemas

- `public`: application tables, all with RLS enabled.
- `private`: helper functions and internal tables (`rate_limits`, queue
  claiming, membership checks). Not exposed through the API.

## Tables

| Area       | Table                                                     | Notes                                                                       |
| ---------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tenancy    | `organisations`, `organisation_members`, `profiles`       | roles: owner, admin, operator, viewer                                       |
| Settings   | `system_settings`                                         | simulation mode, kill switch, budgets, loop guard, retries, audit retention |
| Agents     | `departments`, `agents`, `agent_permissions`              | copied from the registry per organisation                                   |
| Agents     | `agent_status_transitions`                                | every status change, written by trigger                                     |
| Events     | `agent_events`                                            | append-only event stream shown in the UI                                    |
| Audit      | `audit_logs`                                              | append-only; actor is a user, agent or system                               |
| Tenders    | `tender_sources`, `tenders`, `tender_status_history`      | history is append-only                                                      |
| Workflow   | `workflow_runs`, `tasks`, `task_dependencies`, `handoffs` | one active run per tender                                                   |
| Decisions  | `approvals`                                               | one pending approval per task                                               |
| Submission | `submission_records`                                      | package hash, method, simulated flag                                        |
| People     | `notifications`                                           | per user                                                                    |
| Cost       | `cost_usage`                                              | append-only, `is_simulated` flag                                            |
| Queue      | `jobs`                                                    | status, attempts, run_after, locks, dead letter                             |
| Ops        | `worker_heartbeats`, `private.rate_limits`                |                                                                             |

Every tenant table carries `organisation_id`, and cross-table foreign keys
include it (`(organisation_id, id)`), so a row cannot reference another
organisation's data even through a bug.

## Tender state machine

Statuses run from `DISCOVERED` through `INGESTING`, `ANALYSING`,
`QUALIFYING`, `QUALIFIED`, `COMPLIANCE_REVIEW`, `PREPARING_BID`, `PRICING`,
`QUALITY_ASSURANCE`, `READY_FOR_APPROVAL`, `APPROVED`, `SUBMITTING` and
`SUBMITTED`, with side states such as `MISSING_INFORMATION`, `QA_FAILED`,
`SUBMISSION_FAILED`, `REJECTED`, `CANCELLED` and `ARCHIVED`, and outcomes
`UNDER_EVALUATION`, `AWARDED`, `UNSUCCESSFUL`.

Allowed transitions are defined once in `lib/domain/tender-state.ts` and
enforced again by the `guard_tender_status` trigger
(`private.tender_transition_allowed`). An integration test checks that both
tables match. Users can only set a few statuses directly
(`transition_tender`), always with a reason; the rest belong to the workflow.

## Job queue

- `enqueue_job` inserts into `jobs` with an idempotency key; a trigger sends
  `NOTIFY tenderos_jobs`.
- `private.claim_job` picks the next due job with `FOR UPDATE SKIP LOCKED`
  and locks it to a worker. Stale locks are reclaimed.
- Outcomes: completed, retry (with backoff), defer (paused agent, kill
  switch), dead (dead-letter after max attempts).

Temporal was considered and deferred; see `docs/adr/0002-postgres-job-queue.md`.

## Access model

- **Reads**: RLS policies use `private.is_org_member(organisation_id)`.
  Notifications are filtered to the user. Tenders have column-level grants.
- **Writes from people**: only through `SECURITY DEFINER` RPCs that check
  `private.has_org_role(...)` and write an audit entry:
  `start_tender_workflow`, `decide_approval`, `set_agent_control`,
  `retry_task`, `cancel_workflow`, `set_kill_switch`, `transition_tender`,
  `mark_notifications_read`, `change_tender_delivery`, plus tender insert and update under
  column grants (the delivery columns are locked once a bid is waiting for approval or
  delivery: trigger `guard_delivery_details`, migration `20261010000055`).
- **Totals**: the API returns at most 1000 rows (`max_rows`), so a page must never fetch
  rows to count or sum them. `dashboard_counts` (tenders per status, spend) and
  `agent_usage_totals` (an agent's calls, cost and tokens) are `SECURITY INVOKER`
  functions that aggregate in the database under the caller's RLS; long lists page with
  `.range()` (`lib/pagination.ts`). Queries in `lib/data/queries.ts` throw on a database
  error instead of returning an empty list.
- **Writes from agents**: only the worker, over a direct connection, sets
  `app.actor_agent_id` so audit rows name the agent.
- `bootstrap_organisation` is callable by the service role only.
- Append-only tables (`audit_logs`, `agent_events`, `tender_status_history`, `agent_status_transitions`,
  `cost_usage`) reject `UPDATE`, `DELETE` and `TRUNCATE` through `private.reject_mutation` and
  `private.reject_truncate`. Two things get past the update/delete trigger: an update whose only change is
  clearing `actor_user_id` (what `on delete set null` does when an account is deleted), and the erasure and
  retention functions, which set `app.erasure = 'on'` for their own transaction. `service_role` has no
  `TRUNCATE` on them. `audit_logs.organisation_id` is a plain uuid, so the trail outlives an erased organisation.
- Erasure, export and retention (service role only, `docs/popia-operations.md`): `erase_user`,
  `erase_organisation`, `export_user_data`, `export_organisation_data`, and `private.run_retention_purge()`
  (pg_cron `tenderos-retention-purge`, daily). A `before delete` trigger on `email_accounts` deletes the
  mailbox's Vault secret, so removing a member or an organisation never leaves a credential behind.

## Realtime

The `supabase_realtime` publication includes agents, tasks, agent_events,
handoffs, approvals, tenders, workflow_runs and notifications. RLS applies to
realtime too, so a client only receives its organisation's rows.
