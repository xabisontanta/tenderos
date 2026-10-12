# AGENTS.md

Rules for the TenderOS agent system, for the humans and coding agents who
change it. If code and this file disagree, fix one of them in the same change.

## 1. System architecture

```
Browser (Next.js App Router, React 19)
  │  server actions ──► Supabase RPCs (SECURITY DEFINER, role-checked)
  │  realtime      ◄── postgres_changes on agents, tasks, agent_events, handoffs,
  │                    approvals, tenders, workflow_runs, notifications
  ▼
Supabase Postgres  ◄──────────── Worker (Node, `npm run worker`)
  jobs queue (SKIP LOCKED + LISTEN/NOTIFY)        WorkflowEngine
  RLS on every table                              Agent executors
  append-only agent_events / audit_logs           Direct pg connection
```

- The UI never runs agent work. It starts workflows and records human
  decisions through RPCs that enqueue jobs.
- The worker claims jobs, runs one agent step per job, persists the result,
  emits events, creates the next task and handoff, and enqueues the next job,
  all in one transaction per step.
- Every state change the UI shows is a database row. No component invents
  activity. Realtime only tells the UI that rows changed.

## 2. Agent hierarchy

Source of truth: `agents/registry.ts`. Each organisation gets a copy of the
registry at sign-up (`bootstrap_organisation`).

| Department                | Agent (slug)                                      | Tier | Active in milestone 1 |
| ------------------------- | ------------------------------------------------- | ---- | --------------------- |
| Executive / Orchestration | Tender Director (`tender_director`)               | MID  | yes, plans every run  |
| Executive / Orchestration | Deadline Agent (`deadline`)                       | LOW  | no                    |
| Tender Intelligence       | Tender Scout (`tender_discovery`)                 | LOW  | yes, scans eTenders   |
| Tender Intelligence       | Qualification Agent (`opportunity_qualification`) | MID  | yes                   |
| Tender Intelligence       | Intelligence Analyst (`tender_intelligence`)      | MID  | no                    |
| Bid Operations            | Tender Analyst (`tender_analyst`)                 | MID  | yes                   |
| Bid Operations            | Proposal Writer (`proposal_writer`)               | MID  | yes                   |
| Bid Operations            | Forms Agent (`forms`)                             | LOW  | no                    |
| Compliance & Governance   | Compliance Officer (`compliance`)                 | MID  | yes                   |
| Finance & Pricing         | Pricing Analyst (`pricing`)                       | MID  | yes                   |
| Quality Assurance         | QA Reviewer (`quality_assurance`)                 | HIGH | yes                   |
| Submission Operations     | Submission Officer (`submission`)                 | LOW  | yes                   |
| Communications            | Communications Agent (`communications`)           | LOW  | no                    |
| Document Management       | Document Manager (`document_manager`)             | LOW  | no                    |

The Tender Director is the only agent that plans. Other agents do one kind of
step and hand off. Agents marked "no" exist, show in the Office and can be
paused, but no workflow routes to them yet; their page says so.

### Discovery

The Tender Scout scans National Treasury eTenders (`agents/discovery/etenders.ts`)
for the organisation's watched provinces, on request from the Discover page
and every morning at 04:00 UTC (pg_cron `tenderos-daily-discovery`). It stores
only facts present in the portal row, deduplicates on the portal id, and, when
`auto_run_workflows` is on, starts the `tender_bid` workflow on up to
`max_auto_workflows_per_scan` tenders that still leave 48 hours to bid.

The portal's data is not trusted. Every text field has control characters (NUL
included, which Postgres refuses) stripped; a tender with no usable description
or reference is titled `eTenders <id>`; a field of the wrong shape counts as
missing. Rows that cannot become a tender (unreadable, no closing date, no
issuing organisation, refused by the database) are counted, never dropped
silently: `discovery_runs.rows_seen` and `rows_skipped`. If more than
`DISCOVERY_MAX_INVALID_PCT` percent (default 20) of the rows are unusable the
scan fails with that explanation, instead of completing with "0 matched".
Tenders are stored a chunk at a time with a savepoint per tender, so one row the
database refuses is skipped and the others are kept.

With AI switched on (section 11), five steps of the `tender_bid` plan run a
model instead of rules: the Tender Analyst, the Qualification Agent's fit
assessment, the Proposal Writer, the Pricing Analyst and the QA Reviewer. Each
is a draft for a person (`docs/ai-agents.md`); the rule gates and the approval
gate are unchanged. Simulation runs never call a model.

`tender_bid` uses the same plan as `simulated_bid` on real tenders. Compliance
gaps block it at `MISSING_INFORMATION`; saving the company profile or adding a
verified document re-queues blocked compliance tasks. A bid the approver sent
back (`PREPARING_BID`) or QA failed (`QA_FAILED`) can be prepared again with
`rerun_bid`: a new run that starts at compliance and reuses the earlier run's
analysis and qualification (`options.resume_from`). Real runs are not paced
and their rule-based steps are recorded as $0 `rules` cost, not simulation. After approval the Submission Officer hands over a
verified pack and delivery instructions. TenderOS never submits a bid itself.

## 3. Responsibility boundaries

- One step, one agent, one task row. An agent only reads its task input,
  the tender snapshot and the outputs of earlier steps it is given.
- Agents never change another agent's task, never skip the plan, and never
  transition a tender outside the state machine
  (`lib/domain/tender-state.ts`, mirrored by the DB trigger
  `guard_tender_status`; a parity test keeps them identical).
- Only the Submission Officer can record a submission, and only after an
  approved `BID_SUBMISSION` approval.
- Pricing, legal declarations and submission are always human decisions.

## 4. Data access rules (POPIA data minimisation)

- Data categories (`data_category` enum) are granted per agent in
  `agent_permissions`. The registry lists each agent's categories.
- Before an executor runs, `authoriseExecutor` (`agents/runtime/permissions.ts`)
  checks that the agent holds every category the executor declares. A missing
  grant is a `PermissionDeniedError`: the task fails without retrying.
- Director personal data, banking and proof of address are only granted to
  the Document Manager.
- Prompts: nothing reaches a model except through `buildPrompt`
  (`agents/runtime/ai/guardrails/data-policy.ts`). Each part names its data
  category and is refused if the category is director personal data, banking
  or proof of address (`PROMPT_PROHIBITED_CATEGORIES`, the same list as the
  vault's restricted categories), if the agent was not granted it for the
  task, or if the text holds a South African ID number. Company facts for a
  prompt are an allow-list (`agents/runtime/ai/facts.ts`): names, CIDB grade,
  B-BBEE level, provinces, sectors, and verified, in-date certification and
  reference documents. Contact details, signatories, addresses, tax and
  registration numbers, the exposure limit and file names are never sent.
  A unit test fails if a prohibited category can reach the builder.
- Company documents (`company_documents`, `lib/domain/documents.ts`) each carry
  the data category of their type. The engine gives an agent metadata only
  (`AgentContext.documents`: id, type, title, file name, expiry, verified) for
  the categories it holds, never file contents or signed URLs. The type list
  is mirrored by the table's check and `private.document_category`; a parity
  test keeps them identical.
- Files are served only while their document row is live; director IDs, bank
  letters and proof of address only to owners and admins. Pages sign a
  60-second download link on click through `document_download`, which audits
  the access. Never embed signed URLs in rendered pages.
- Compliance treats a document as evidence only when it is verified and in
  date at closing (a document dated D is valid to the end of D in South
  Africa), and records its `document_id`. Company profile entries are never
  evidence on their own; they leave the item `REQUIRES_CONFIRMATION`. The Submission Officer's
  bid pack lists those documents as `attachments`. Verifying or adding a
  verified document re-queues blocked compliance tasks.
- Browser users read through RLS (`private.is_org_member`) and write only
  through RPCs that check role (`private.has_org_role`).

## 5. Tool access

Each agent has an `allowedTools` allow-list in the registry, stored on the
agent row. The runtime enforces the stored list: an executor reaches every tool
through `ctx.tools.run(toolId, fn)` (`agents/runtime/tool-access.ts`). A tool
that is not on the list is never run, the task fails without a retry, and the
refusal is written as an `agent_events` row (`TOOL_REFUSED`) with severity
`WARNING`. Ids match exactly; there are no wildcards. Each executor declares
the tools it uses (`AgentExecutor.tools`) and a unit test checks they are on
its agent's registry list.

The tools in use: `tender.documents.read` (Tender Analyst reads the documents),
`company.capabilities.read` and `company.references.read` (company facts for
the Qualification Agent and Proposal Writer), `pricing.model`, `bid.read`, and
`web.search` (Anthropic's server-side web search, for the Tender Scout and
Intelligence Analyst only). `web.search` also needs the organisation's own web
research switch; without it the call is refused and logged the same way.
Agents created before a tool was added get it from a migration (see
`supabase/migrations/20261010000030_ai_agent_tools.sql`).

### Browser helper (`extension/`)

The browser helper is a person's tool, not an agent. It runs only when a
member clicks **Apply with TenderOS** on a tender page or **Fill this page** in
their own browser, and it fills but never submits: it fills company details and
attaches verified documents, and never clicks a submit, send or confirm button,
ticks a declaration, enters a price or amount, or signs. Skip rules live in
`extension/src/match.js` and are unit-tested; never relax them. It
authenticates with a pairing code (`autofill_tokens`, stored as a SHA-256 hash,
30 days, revoked when the member leaves) through `/api/autofill/*`, which serves
only the profile, the documents the member's role may read (section 4), approved
bids awaiting delivery and, for one tender at a time, an apply plan (portal
address, company facts, the approved bid pack documents), and audits every file
download. Pairing is zero-copy: **Connect browser** creates the code and hands
it to the helper over `window.postMessage` (versioned, origin- and
nonce-checked, schema-validated); the code is never displayed, put in a URL or
logged, and only the extension's background worker holds it. The helper fills a
page only when its registrable domain is the tender's portal (otherwise the
person confirms, naming both hosts), only over https, only in the top frame and
same-origin frames, and reports just the host and counts back
(`autofill_record_prepared`: audit log plus a tender event). Personal
documents (director IDs, bank letters, proof of address) go only to owners and
admins who tick the option. The production manifest has no wildcard or optional
host permissions and no localhost (`npm run build:extension` enforces this).

## 6. Handoff conventions

- A handoff row is created for every step boundary, inside the same
  transaction as the next task: `from_agent_id` → `to_agent_id`,
  `handoff_type` (e.g. `REQUIREMENTS_EXTRACTED`), `payload` (the structured
  output the next agent needs), `correlation_id` of the run.
- Handoffs into the approval gate set `to_approval`. The handoff out of the
  gate sets `from_approval`, because the human decision is its source.
- The receiving agent marks the handoff `ACCEPTED` when it starts the task.
  A human decision settles the handoff into the gate (`ACCEPTED`/`REJECTED`).
- `HANDOFF_CREATED` events drive the Office animation. No other trigger draws
  a handoff line.

## 7. Structured output schemas

Every executor folder has `schema.ts` (zod), `logic.ts` (pure functions,
unit-tested) and `simulated.ts` (the executor). The five steps that do
judgement work also have `real.ts`, the model-backed executor for the same task
type, chosen by `getExecutor(taskType, { simulation, aiEnabled })`
(`agents/index.ts`); `simulated.ts` stays the default and the rules-only
behaviour. Outputs are validated against the schema before they are stored in
`tasks.output`. The model is asked for JSON generated from the same zod schemas
(`z.toJSONSchema`, structured outputs), validated, and given one repair attempt
before the task fails without a retry. Unknown or unverifiable fields are
explicit:

- `MISSING_INFORMATION`: the tender record does not contain it.
- `REQUIRES_CONFIRMATION`: a person must confirm it before it can be relied on.

Output a model took part in carries `ai_generated: true` and is a draft for a
person to review.

## 8. Approval policies

- Submission always needs an approved `BID_SUBMISSION` approval from an
  owner or admin. Operators and viewers cannot decide.
- Rejecting requires a reason. Decisions are final and audited.
- One pending approval per task (unique index). Expired approvals cannot be
  decided. Approvals expire at the tender's closing time; pg_cron
  `tenderos-expire-approvals` marks them every 15 minutes and the engine
  cancels the run and the tender.
- Where and when a bid is delivered (`submission_destination`, `submission_method`,
  `source_url`, `closing_at`) is locked from `READY_FOR_APPROVAL` on, and while any
  approval is pending or approved (trigger `guard_delivery_details`): not even an owner
  can edit the columns. Owners and admins use `change_tender_delivery`, which cancels
  the approval and run, fails an undelivered pack, sends the tender back to
  `PREPARING_BID`, applies the change and audits who changed what and why; the bid is
  then prepared again and approved afresh. A bid that was already delivered cannot be
  changed. The portal may still move the closing date (a pending approval's expiry
  follows); discovery never applies a changed address, method or link to a locked bid
  and reports it instead.
- TenderOS never auto-submits. In simulation mode the submission is a record
  with a package hash; nothing leaves the system.
- An approved bid is emailed only when an owner or admin presses Send on the
  tender page (`sendBidEmail`), from a mailbox they connected themselves.
  Agents never send email. Every send is logged in `email_messages`, and
  `record_bid_delivery` closes the submission, tender and run. A bid is emailed
  at most once: the send is reserved first as a message in state `SENDING`
  (one `SENDING` or `SENT` message per submission, a unique index), then
  mailed, then marked `SENT` or `FAILED`; a `FAILED` attempt can be retried.
  An attempt that was interrupted stays `SENDING` and blocks another send until
  a person has checked the mailbox's Sent folder and either records the delivery
  or, if nothing went out, marks that message `FAILED` by hand (database
  access). Errors writing the message or the mailbox status are logged and, for
  the message, shown to the person, never swallowed.
- Mailbox credentials (Gmail refresh token or SMTP password) live in Supabase
  Vault. Browsers cannot read `secret_id`; only the service role can decrypt,
  through `email_account_credential`, and only for the member who connected
  the mailbox. SMTP hosts must resolve to public addresses (`lib/email/network.ts`).

## 9. Error handling

- Transient failures retry with exponential backoff and jitter
  (`workflows/retry.ts`), up to the task's `max_retries` (default 3).
- After the last retry the task is `FAILED`, the run is `BLOCKED`, members are
  notified, and an operator can retry the task (`retry_task`).
- `NonRetryableError` and `PermissionDeniedError` fail at once.
- Jobs that crash repeatedly are dead-lettered; the engine then fails the
  task so nothing stays `RUNNING`.
- Paused or disabled agents and the kill switch defer jobs instead of losing
  them. A loop guard caps tasks per run (`max_tasks_per_workflow`).
- Errors are shown to users as they are. Never swallow an error to make a
  screen look healthy.

## 10. Logging

- `agent_events` is the user-visible, append-only event stream.
- `audit_logs` is the append-only compliance trail (who did what, as which
  actor). Updates, deletes and truncates are rejected by trigger, with two
  exceptions: clearing the actor when an account is deleted, and the erasure and
  retention functions (`erase_user`, `erase_organisation`,
  `private.run_retention_purge`), which de-identify or delete under
  `app.erasure`. Erasure keeps the trail but removes names, addresses, ids and
  what people typed; the runbook is `docs/popia-operations.md`. A new table that
  holds personal data must be covered by `erase_user` and the exports, and a new
  foreign key to `auth.users` must be `on delete set null` or `cascade`, never
  `restrict`.
- Process logs use `lib/log.ts`: JSON lines with secret redaction. Never log
  tokens, keys, document contents or personal data. Every model call writes
  one `ai.call` line with the model, token counts, cost, the prompt's block
  labels, categories, sizes and a hash, and whether the answer validated; never
  the prompt text or the model's answer (`agents/runtime/ai/logging.ts`).

## 11. Model-selection policy

- Each agent has a cost tier (LOW / MID / HIGH). `selectModel` maps tier to a
  model from `AI_MODEL_LOW`, `AI_MODEL_MID`, `AI_MODEL_HIGH`; high-value or
  complex work moves up one tier. An agent can carry a `model_override`.
- No model names are hard-coded. Unset tiers mean "not configured", and real
  execution refuses to run rather than fall back silently: a missing
  `ANTHROPIC_API_KEY`, a missing model for the agent's tier or a missing price
  (`AI_PRICE_*`) fails the task before it starts, with the variable named.
- AI is off by default. It runs only on real (non-simulation) tenders, and only
  when both switches are on: `system_settings.ai_enabled` for the organisation
  (owners and admins set it in Settings, AI assistance, through `set_ai_settings`,
  after ticking that they have read what is sent to Anthropic; it is refused
  while the daily AI budget is zero) and `AI_ENABLED=true` in the worker's
  environment, which is the deployment's kill switch. Otherwise the rules-only
  executors run. Web research (`ai_web_research_enabled`) is a further switch
  under the first. Settings shows today's and this month's spend, summed by the
  database (`ai_spend`), and what the web server's environment is missing.
- Simulation mode makes no AI calls and records cost as $0 with
  `is_simulated = true`. Rule-based steps on a real tender record $0 with
  provider `rules`; AI steps record provider `anthropic`, the model and the
  real token counts and USD cost (cache reads and writes and web searches
  priced; ZAR display is a separate concern).
- The daily AI budget blocks non-simulated work once spent. It now sees real
  numbers. A task also stops before any model call that would take it past
  `AI_MAX_TASK_COST_USD` or past what is left of the day's budget, and the
  spend of a failed attempt is recorded too.

## 12. Security restrictions

- RLS on every table; the service role key and `DATABASE_URL` are server-only.
- Writes from users go through role-checked RPCs; agents write through the
  worker only.
- Per-request nonce CSP, HSTS in production, frame-ancestors none.
- Rate limits on sensitive actions (`hit_rate_limit`) live inside the RPCs,
  not only in server actions. A new state-changing RPC must call it; the
  hardening integration test lists them.
- Secrets live in environment variables, never in the repo.

See `docs/security.md` for the full model.

## 13. Anti-hallucination requirements

- Never invent company facts, tender facts, prices, certificates, references
  or deadlines. If it is not in the source data, mark it
  `MISSING_INFORMATION` or `REQUIRES_CONFIRMATION`.
- Every output field that came from a document must be traceable to it. A
  requirement the Tender Analyst extracts carries a verbatim `quote` and a
  `page` or `section`, and counts as `EXTRACTED` only if the quote is found in
  the text the model was given (after whitespace, case and quote-mark
  normalisation). Otherwise it is kept as `REQUIRES_CONFIRMATION` with the
  reason (`agents/runtime/ai/guardrails/citations.ts`). A PDF without a text
  layer can be read but nothing from it can be verified.
- Tender and company text reaches a model only inside content-hashed
  `UNTRUSTED_DATA` markers, and every system prompt says it is data, not
  instructions. Text that reads like a command to an AI system is reported
  (`injection_warnings`, a `PROMPT_INJECTION_SUSPECTED` event), and a quote
  taken from the line of such text is never trusted as a requirement.
- Pricing agents structure schedules; they do not produce figures without
  supplier quotations and human input. The Pricing Analyst's model schema has
  no price field and every amount stays empty.
- The Proposal Writer drafts only from the allow-listed company facts and the
  analysed requirements; every paragraph cites them, and a paragraph with
  figures found in neither is removed. A section the facts do not support
  stays `MISSING_INFORMATION`.
- QA treats missing information as an open issue, never as a pass. An AI
  review can add open issues; it cannot fail a bid, clear an issue, or pass a
  requirement without citing complete bid content.
- The Qualification Agent's AI fit assessment never changes the decision,
  which the rule gates make.
- Simulated work is labelled simulated everywhere it appears.
