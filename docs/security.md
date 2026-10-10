# Security architecture

## Principles

Least privilege for people and agents, defence in depth (checks in the
database as well as the app), no secrets in source control, and an
append-only record of every consequential action.

## Identity and tenancy

- Supabase Auth (email and password). Sessions are refreshed in middleware;
  every authenticated page resolves the user and their organisation, and
  redirects otherwise.
- Every tenant row has `organisation_id`. RLS restricts reads to members.
  Composite foreign keys stop cross-tenant references.

## Authorisation

| Action                                                 | owner | admin | operator | viewer |
| ------------------------------------------------------ | ----- | ----- | -------- | ------ |
| View everything in the organisation                    | ✓     | ✓     | ✓        | ✓      |
| Create tenders, start or cancel workflows, retry tasks | ✓     | ✓     | ✓        |        |
| Decide approvals                                       | ✓     | ✓     |          |        |
| Pause, resume, disable or enable agents                | ✓     | ✓     |          |        |
| Engage or release the kill switch                      | ✓     | ✓     |          |        |

The UI hides controls a role cannot use, but the RPC is the enforcement point.
Integration tests cover role refusals and cross-tenant isolation.

## Agents

- Data-category grants per agent, checked before every step
  (`authoriseExecutor`). Sensitive categories (director personal data,
  banking, proof of address) are granted only to the Document Manager.
- Tool allow-lists per agent.
- Agents write only through the worker, never through the browser.
- Kill switch, per-agent pause and disable, loop guard, daily budget.
- No automatic submission: a human approval is required by the workflow and
  by the database (approval rows can only be decided through
  `decide_approval` by owners and admins).

## Web hardening

- Content-Security-Policy with a per-request nonce and `strict-dynamic`;
  pages render dynamically so the nonce reaches every script. Connections are
  limited to this origin and the Supabase project.
- `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict
  referrer policy, restrictive Permissions-Policy, COOP, and HSTS in production.
- Inputs are validated with zod in server actions and again by database
  constraints.
- Rate limits (fixed window, stored in Postgres) on tender creation,
  workflow start, approvals, agent controls and task retries. Sign-in and
  sign-up rely on Supabase Auth's built-in rate limits.
- Open-redirect protection on the `next` parameter after sign-in.

## Secrets

- `.env.example` holds placeholders only. `.env*` is gitignored, except the example.
- The service role key is used only by the admin client, which is marked
  `server-only`; `DATABASE_URL` is used only by the worker process. Neither
  has a `NEXT_PUBLIC_` prefix.
- The logger redacts keys, tokens, passwords and authorization headers.

## Audit

`audit_logs` records actor type (user, agent, system), actor id, action,
resource, correlation id and metadata. It is append-only by trigger.
Retention is configurable (minimum 365 days, default about seven years).

## Not yet built (tracked in the roadmap)

- Company document vault with encryption at rest using `ENCRYPTION_KEY`,
  signed URLs and per-document access logs.
- MFA for owners and admins, invitations and member management.
- Sentry error reporting (`SENTRY_DSN`) and alerting.
- Signed webhooks using `WORKFLOW_SECRET`.
