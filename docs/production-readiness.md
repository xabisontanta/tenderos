# Production readiness: gap analysis and plan

Produced on 2026-10-10 from five independent read-only reviews (architecture
walk-through, security, database, SaaS/discovery gap analysis, code quality
and tests) plus a clean baseline run. Items marked **verified** were
re-checked against the code by hand; the rest are reviewer findings that
should be confirmed when the work item is picked up.

Baseline on `main` (e0e31d4): `npm ci`, lint, typecheck and 188 unit tests
pass. The production build, integration tests (need local Supabase) and
Playwright e2e were not run. `npm audit --omit=dev`: 3 findings (nodemailer
high, postcss-inside-next high, one moderate).

## Objective

TenderOS is a SaaS for South African businesses that need to find tenders and
prepare bids. It must discover tenders across South Africa, qualify them and
prepare bids with AI agents, keep a person approving every submission, and be
safe to operate for paying customers under POPIA.

## Where it stands

**Real today:** eTenders discovery by province (daily and on demand);
rule-based qualification; compliance against uploaded, verified, in-date
documents; document vault; approvals; Gmail/SMTP bid sending; browser-form
autofill extension; sign-up, sign-in and password reset; tenant isolation
through RLS (no cross-tenant path found).

**Not real today:**

- No agent calls an AI provider. `@anthropic-ai/sdk` is a dependency with no
  import (**verified**). Proposal Writer and Pricing are stubs, and nothing in
  the UI lets a person enter proposal or pricing content, so every real bid
  ends QA as conditional with open issues. The product finds tenders and
  assembles a document list; it does not yet produce a bid.
- Tender documents are never downloaded or read (`documents_analysed` is 0).
- One discovery source (eTenders public list feed).
- No billing, plans, limits, invitations, MFA, public site, CI, error
  reporting or erasure path.

## Findings by priority

### P0: blocks a paid launch

| #   | Finding                                                                                                                                                                                                                                                                                                                         | Evidence                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | **POPIA erasure is impossible.** The append-only trigger rejects UPDATE as well as DELETE, and `actor_user_id ... on delete set null` is an UPDATE, so deleting any user who has acted fails. `audit_logs.organisation_id` is `on delete restrict`, so organisations cannot be deleted. No retention job exists.                | **verified**: `..001:167-183`; also agent_events, tender_status_history |
| 2   | **Auth config unsafe for production.** Confirmation off, 1 s resend limit, built-in mailer capped near 2/h, no CAPTCHA, no MFA, localhost site URL. Sign-up for an existing email behaves differently from a new one while confirmation is off (enumeration, pre-registration).                                                 | **verified**: `config.toml:160,200,215,229,233,306`                     |
| 3   | **Auth throttling probably shared across all users.** Auth calls are made server-side, so Supabase likely sees one egress IP for everyone. One attacker can exhaust the per-IP quota and lock everyone out; per-account guessing is not throttled. Needs an app-level limiter plus CAPTCHA. Confirm against the hosted project. | reviewer; `features/auth/actions.ts:26,52,74`                           |
| 4   | **Vulnerable `nodemailer` 7.0.13** (fixed in 10.1.0, a major jump). It carries per-tenant SMTP credentials.                                                                                                                                                                                                                     | **verified** with `npm audit`                                           |
| 5   | **No MFA** for owners/admins, who can open director IDs and bank letters and send bids.                                                                                                                                                                                                                                         | `config.toml:306`; no code                                              |
| 6   | **Auth emails built from the client `Origin` header** instead of `APP_URL`.                                                                                                                                                                                                                                                     | **verified**: `features/auth/actions.ts:51,73`                          |
| 7   | **No POPIA product surface:** privacy notice, terms, consent record, data export/deletion, retention schedule, breach process, operator terms, cross-border basis (Supabase has no SA region), rule that director personal data never enters AI prompts.                                                                        | reviewer; none exist in the repo                                        |
| 8   | **No CI** (`.github/` absent, **verified**), no error reporting (`SENTRY_DSN` unused), no worker container, no staging, no backup/restore plan.                                                                                                                                                                                 | reviewer                                                                |
| 9   | **Hosted worker likely never runs.** Cron calls `/functions/v1/tenderos-worker` (**verified**, `..008:38`) but the function folder is `supabase/functions/worker`, no `[functions.*]` mapping exists, and scheduling is a manual SQL step.                                                                                      | **verified** (name mismatch)                                            |
| 10  | **Bid email can be sent twice** (non-atomic `alreadySent` check, ignored insert errors).                                                                                                                                                                                                                                        | reviewer; `features/email/actions.ts:109-114,167`                       |
| 11  | **Delivery address editable after approval.** An operator can change `submission_destination` and `closing_at` after an admin approves; found independently by two reviewers.                                                                                                                                                   | `..003:255-259`; `features/email/bid-delivery.tsx:64`                   |
| 12  | **One bad eTenders row can fail the scan for every tenant** (`clean(...)!` returns null into a NOT NULL column; NUL characters; failed rows silently dropped). Each organisation also downloads the full national feed.                                                                                                         | reviewer; `etenders.ts:132,201`; `discovery.ts:109-199`                 |
| 13  | **Worker can crash on a DB blip** (unguarded `finish()` rejection exits the process).                                                                                                                                                                                                                                           | reviewer; `workflows/worker.ts:106,137,179`                             |
| 14  | **Business model absent:** no plans, billing, metering or entitlement gates; no public landing, pricing, terms or privacy pages (middleware sends everything to login).                                                                                                                                                         | **verified**: `lib/supabase/middleware.ts:6`                            |

### P1: first paying customers

- Invitations, role changes, member removal, last-owner guard. Today there
  is no insert path into `organisation_members`, `bootstrap_organisation`
  rejects anyone already in an organisation (**verified**, `..005:27`), and
  `requireContext` takes the first membership with no ordering or switcher.
- Guided onboarding (sectors, provinces, CIDB grade, keywords, first
  documents) instead of one company-name field.
- Upload validation is bypassable by calling the RPC and Storage directly;
  malware scanning absent; orphan uploads never cleaned.
- Browser extension injects into any tab with no host match, and ships
  `localhost` and a wildcard optional host permission.
- Discovery quality: shared national catalogue crawled once; keyword, sector,
  CIDB, value and municipality matching; auto-run off by default; saved
  searches; email digests and closing-date reminders; amendment history and
  cancellation detection; cross-source de-duplication.
- Real AI: provider adapter, structured outputs from the existing zod
  schemas, document ingestion with page references, citation checks, monthly
  and per-tender budgets with reservation, editable settings, prompt-injection
  handling, evaluation set.
- Human-entered proposal and pricing inputs in the UI.
- Hot-path indexes, RLS performance (`is_org_member` per row), notification
  policy ignoring membership, `max_rows=1000` truncation in aggregates,
  `.gitattributes` for CRLF migrations, text-patched migrations 14 and 16.
- Silent failures: DB errors rendered as empty UI, swallowed OAuth errors,
  form values lost on validation errors, unbounded realtime subscriptions.
- Tests: no coverage of auth flows, server actions, email send, upload
  registration, discovery edge cases or rate limits; integration and e2e
  tests never run in CI.

### P2: growth

Further SA sources (CIDB i-Tender, Eskom/Transnet/SANRAL and other SOEs,
metros and provincial treasuries, universities and SETAs), inbound-RFQ email
ingestion, WhatsApp alerts, award tracking and win/loss analysis, second
payment gateway, status page, admin/support console.

### Cleanup

Dead `connectors/` module, unused Radix packages, `ENCRYPTION_KEY` and
`WORKFLOW_SECRET` consumed by nothing, `OPENAI_API_KEY` in `.env.example`
while the dependency added is Anthropic's, `allowedTools` stored but not
enforced although `AGENTS.md` implies otherwise, undeclared `esbuild`, and
stale `architecture.md`, `database.md`, ADR 0003 and roadmap.

## Plan and the ECC components for each task

Skill and agent names below come from the installed ECC plugin's listings.
They are matched by their descriptions; read the skill before relying on it.
ECC has no legal or POPIA skill, so privacy notice, terms, operator
agreements and the Information Officer registration need a South African
attorney. Draft text can be prepared, but is not legal advice.

| Phase | Work                                                                                                                                                                                                              | ECC skills / agents                                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Safety net: CI workflow, `.gitattributes`, env/config fixes, worker crash fix, dependency upgrades                                                                                                                | `ecc:verification-loop`, `ecc:quality-gate`, `ecc:github-ops`, `ecc:build-error-resolver`                                                                                                                 |
| 1     | **Sign-up and authentication:** APP_URL links, app-level auth rate limits, CAPTCHA, email confirmation, consent record, MFA (TOTP, aal2 on privileged RPCs), invitations and member management, guided onboarding | `ecc:orch-add-feature`, `ecc:tdd-workflow` / `ecc:tdd-guide`, `ecc:security-review` / `ecc:security-reviewer`, `ecc:api-design`, `ecc:frontend-a11y`, `ecc:e2e-testing` / `ecc:e2e-runner`                |
| 2     | Database: erasure and retention, indexes, RLS performance, append-only gaps, bootstrap race, post-approval locks                                                                                                  | `ecc:database-migrations`, `ecc:postgres-patterns`, `ecc:database-reviewer`                                                                                                                               |
| 3     | Reliability fixes: scan resilience, double-send guard, silent failures, aggregates, realtime                                                                                                                      | `ecc:silent-failure-hunter`, `ecc:backend-patterns`, `ecc:react-reviewer`, `ecc:performance-optimizer`                                                                                                    |
| 4     | Discovery automation: shared catalogue, OCDS and further SA connectors, matching, alerts, reminders                                                                                                               | `ecc:deep-research` (confirm each portal's real API and terms first), `ecc:api-connector-builder`, `ecc:data-scraper-agent`, `ecc:contract-first`, `ecc:hexagonal-architecture`                           |
| 5     | Billing and public site: plans, ZAR/VAT invoicing, gateway, entitlements, landing, pricing, legal pages                                                                                                           | `ecc:finance-billing-ops`, `ecc:customer-billing-ops`, `ecc:frontend-design-direction`, `ecc:design-system`, `ecc:seo`                                                                                    |
| 6     | Real AI: provider adapter, document ingestion, proposal and pricing inputs, budgets, evaluation set, prompt-injection defences                                                                                    | `ecc:cost-aware-llm-pipeline`, `ecc:eval-harness`, `ecc:ai-regression-testing`, `ecc:agent-security-hardening`, `ecc:prompt-caching-strategy`, `ecc:nutrient-document-processing`, the `claude-api` skill |
| 7     | Operations: Sentry, alerting, worker container, staging, backups, runbooks, breach process                                                                                                                        | `ecc:deployment-patterns`, `ecc:docker-patterns`, `ecc:canary-watch`, `ecc:doc-updater`, `ecc:docs-governance`                                                                                            |
| 8     | Final gate: full review, dead-code removal, docs brought in line                                                                                                                                                  | `ecc:code-reviewer`, `ecc:typescript-reviewer`, `ecc:refactor-cleaner`, `ecc:production-audit`, `ecc:harness-audit`                                                                                       |

Each phase ends with lint, typecheck, unit tests and build green, plus
integration tests against local Supabase where the phase touches the
database.

## Decisions that belong to the product owner

1. **Payment gateway.** Paystack (ZAR subscriptions, cards and EFT) is the
   reviewer's lead suggestion; PayFast is the alternative. The claim that
   Stripe cannot onboard South African merchants was not verified here and
   should be checked before ruling it out.
2. **AI provider.** The repo added the Anthropic SDK but `.env.example` still
   names OpenAI. Pick one.
3. **Organisation model.** Today one user belongs to one organisation. Keeping
   that is simpler; consultants serving several clients will want many.
4. **Hosting and region.** Supabase has no South African region, which
   affects the POPIA cross-border basis. Vercel plus Supabase is assumed.
5. **Legal.** Information Officer, privacy notice, terms and operator
   agreements need a named owner.

## Status update, 2026-10-12

Decisions taken: one organisation per user; Anthropic as the AI provider;
payment gateway out of scope for now; legal text is a draft for an attorney.

Verified on the `production-readiness` branch (2026-10-12): lint and typecheck
clean, 1449 unit tests, 306 integration tests against local Supabase (TOTP and
confirmations on), a production build, and 9 end-to-end tests in a real
browser.

**Resolved (P0 numbers refer to the table above)**

- #2 auth settings: confirmation required, 60 s resend, URL settings and
  email limits are in `supabase/config.toml`. The hosted-project checklist is
  in `docs/auth.md`; hosted settings are not changed by this repo.
- #3 shared throttling: app-level limits per hashed address and email, with
  an optional Turnstile CAPTCHA (`CAPTCHA_MODE`). Enable Supabase CAPTCHA too,
  because direct `/auth/v1` calls bypass the app limiter.
- #4 `nodemailer` upgraded to 10.1.0.
- #6 auth links come from `APP_URL`, never from the request.
- #8 CI workflow added (`.github/workflows/ci.yml`). Still missing: Sentry,
  alerting, a worker container, staging and backups.
- #13 the worker no longer dies when a job-outcome write fails.
- Extension permissions: production manifest has no wildcard or localhost
  hosts; fills only on the tender's own portal host.
- Also done: terms/privacy consent record and draft pages, one organisation
  per user in the database, guided onboarding, 18 branded emails, one-click
  browser pairing and "Apply with TenderOS", an Anthropic AI layer with
  guardrails and real Tender Analyst, Qualification, Proposal, Pricing and QA
  executors (not yet run against the live API), and a Windows fix for
  `db:env`.

**Resolved in the hardening pass (migrations 050 to 058)**

- #1 POPIA erasure and retention: the append-only trigger now lets two things
  through (clearing the actor, and the erasure and retention functions), the
  audit trail no longer restricts deleting an organisation, and the other
  foreign keys that blocked deleting a user or a mailbox are fixed. Service-role
  `erase_user` and `erase_organisation` de-identify the trail and delete the
  rest, `export_user_data` and `export_organisation_data` answer access
  requests, owners download their organisation's data from Settings, a daily
  retention job runs, and a mailbox's Vault secret is deleted with its mailbox.
  TRUNCATE is rejected on the append-only tables. `docs/popia-operations.md` is
  the runbook (requests, identity checks, erasure, retention, breaches).
- #7, the part that is tooling and process: export, deletion and a breach
  process now exist. The privacy notice and terms are still drafts.
- #9 the hosted worker is mapped to the name cron calls
  (`[functions.tenderos-worker]`), with a test that fails if they drift.
- #10 a bid email is reserved (one `SENDING` or `SENT` message per submission,
  by unique index) before it is sent, so it cannot go out twice.
- #11 a bid's delivery details are locked from the approval gate on; owners and
  admins change them with `change_tender_delivery`, which withdraws the approval.
- #12 a bad eTenders row no longer fails or empties a scan: control characters
  stripped, untitled rows titled, unreadable rows counted
  (`rows_seen`, `rows_skipped`), the scan failing loudly above 20 percent
  unreadable, one savepoint per tender.
- P1: hot-path and foreign-key indexes, the notifications policy follows
  membership, private functions start closed to PUBLIC, RLS on the rate-limit
  table, lists and totals no longer stop at the API's 1000 rows (operations,
  agent page, Discover), and `lib/data/queries.ts` throws on database errors.

**Resolved in the team and MFA pass (migrations 060 to 063)**

- #5 TOTP MFA: enrolment and challenge, a lost-device runbook
  (`reset_user_mfa`), and an owner-controlled "Require MFA" setting that makes
  20 privileged functions, restricted document reads and the service-role paths
  demand a verified second factor. Verified against a real TOTP-enabled Auth
  server on the local stack (integration and end-to-end).
- Team management: role changes, member removal and a last-owner guard that
  holds under concurrency; invitations with a hashed single-use token, a
  platform mailer and a join flow, so accountants and auditors can join a
  client's organisation as read-only viewers. The erasure runbook's
  ownership-transfer step is no longer manual.
- Not verified: a real SMTP server or inbox for invitations (no provider is
  chosen), TOTP on the hosted plan, and the hosted dashboard settings.

**Still open**

- #12, the other half: every organisation still crawls the national feed itself.
- #7: the privacy notice, terms, operator agreement, Information Officer and the
  retention periods in `docs/popia-operations.md` need an attorney. Breach
  detection (error reporting, alerting) is not built.
- AI is off by default and has nothing to read: tender documents are not yet
  downloaded or extracted, there is no `ai_enabled` setting or UI, and no
  screens to review or edit proposal and pricing drafts.
- #14 billing and a public landing page (billing deferred by decision).
- Known and accepted for now: `postcss` inside Next 15's build tooling
  (fixed only by the Next 16 major upgrade).
- Not verifiable here: real Chrome and portal behaviour for the extension,
  the live Anthropic API, real inbox rendering, hosted Supabase settings.
