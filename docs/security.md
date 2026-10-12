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
| Upload company documents                               | ✓     | ✓     | ✓        |        |
| Verify or remove documents                             | ✓     | ✓     |          |        |
| Open director IDs, bank letters, proof of address      | ✓     | ✓     |          |        |
| Connect a sending mailbox, email or record a bid       | ✓     | ✓     |          |        |

The UI hides controls a role cannot use, but the RPC is the enforcement point.
Integration tests cover role refusals and cross-tenant isolation.

## Agents

- Data-category grants per agent, checked before every step
  (`authoriseExecutor`). Sensitive categories (director personal data,
  banking, proof of address) are granted only to the Document Manager.
- Tool allow-lists per agent, enforced in the runtime (`ctx.tools`): a tool
  that is not on the stored list is never run and is logged as a `TOOL_REFUSED`
  WARNING.
- Model prompts: built only through a data-category policy that refuses
  director personal data, bank details, proof of address and ID numbers;
  third-party text is wrapped as data; secrets and document text are never
  logged (`docs/ai-agents.md`).
- Agents write only through the worker, never through the browser.
- Kill switch, per-agent pause and disable, loop guard, daily budget.
- No automatic submission: a human approval is required by the workflow and
  by the database (approval rows can only be decided through
  `decide_approval` by owners and admins).

## Company documents and mailboxes

- Files live in the private `company-documents` bucket under the
  organisation's folder. The Storage read policy only serves a file while its
  `company_documents` row is live, and director IDs, bank letters and proof of
  address only to owners and admins (`private.can_read_document`).
- Pages never embed download links. A click calls `document_download`, which
  applies the same rules, rate-limits and writes a `document.downloaded`
  audit row; the app then signs a 60-second URL that forces a download.
- Uploads are checked server-side: the file's first bytes must match its
  declared type, or the file is deleted. Removing a document deletes the file
  and keeps the record for the audit trail.
- Mailbox credentials (Gmail refresh token, SMTP password) are stored in
  Supabase Vault. Browsers cannot select `secret_id`; only the service role
  decrypts, for the member who connected the mailbox. SMTP hosts must resolve
  to public addresses and connections require TLS 1.2 or later.

## Web hardening

- Content-Security-Policy with a per-request nonce and `strict-dynamic`;
  pages render dynamically so the nonce reaches every script. Connections are
  limited to this origin and the Supabase project.
- `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict
  referrer policy, restrictive Permissions-Policy, COOP, and HSTS in production.
- Inputs are validated with zod in server actions and again by database
  constraints.
- Rate limits (fixed window, stored in Postgres) inside every
  state-changing RPC and on tender inserts, so calling the API directly is
  limited the same as using the app. An integration test fails if an RPC
  loses its limit.
- Sign-in, sign-up and password reset are unauthenticated, so the app limits
  them itself, per visitor address and per email, and can require a
  Cloudflare Turnstile CAPTCHA. Subjects are HMACs, never raw addresses or
  emails; the limiter fails closed. Supabase Auth's own limits stay on as a
  second layer but see one address for every visitor, because the calls come
  from the server. Details and the hosted-project checklist: `docs/auth.md`.
- Auth emails link to `APP_URL`, never to a request header.
- New accounts must confirm their email address (a registered address looks
  like a new one at sign-up) and accept the terms and privacy notice; the
  acceptance (document version, time, keyed hash of the network address) is a
  database record that browsers cannot write. The texts are drafts until an
  attorney reviews them.
- Open-redirect protection on the `next` parameter (`lib/safe-redirect.ts`):
  only same-origin paths, no `//`, backslashes or control characters.
- Passwords: at least 12 characters with letters and digits, checked in the
  app and by Supabase Auth. Hosted projects must also require email
  confirmation and secure password change (Authentication settings).

## Secrets

- `.env.example` holds placeholders only. `.env*` is gitignored, except the example.
- The service role key is used only by the admin client, which is marked
  `server-only`; `DATABASE_URL` is used only by the worker process. Neither
  has a `NEXT_PUBLIC_` prefix.
- The logger redacts keys, tokens, passwords, authorization headers,
  credentials, tax and registration numbers, phone numbers and email
  addresses.
- The hosted worker checks its Vault-held secret over a single connection
  before it opens its pool.

## Audit

`audit_logs` records actor type (user, agent, system), actor id, action,
resource, correlation id and metadata. It is append-only by trigger (no
update, delete or truncate), except that erasing a person clears the actor and
what they typed, and the retention job deletes rows past their period.
Retention is configurable (minimum 365 days, default about seven years). Erasing
a person or an organisation, exporting their data and handling a breach are in
`docs/popia-operations.md`.

## Not yet built (tracked in the roadmap)

- Malware scanning of uploaded documents.
- Removing unregistered uploads (files uploaded but never recorded).
- MFA for owners and admins, invitations and member management.
- Sentry error reporting (`SENTRY_DSN`) and alerting.
- Signed webhooks using `WORKFLOW_SECRET`.
