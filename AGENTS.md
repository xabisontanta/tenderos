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
| Tender Intelligence       | Tender Scout (`tender_discovery`)                 | LOW  | no                    |
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
- Browser users read through RLS (`private.is_org_member`) and write only
  through RPCs that check role (`private.has_org_role`).

## 5. Tool access

Each agent has an `allowedTools` allow-list in the registry, stored on the
agent row. Milestone 1 executors call no external tools. When real tools are
added, the runtime must refuse any tool that is not on the list, and log the
refusal as an `agent_events` row with severity `WARNING`.

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
unit-tested) and `simulated.ts` (the executor). Outputs are validated against
the schema before they are stored in `tasks.output`. Unknown or unverifiable
fields are explicit:

- `MISSING_INFORMATION`: the tender record does not contain it.
- `REQUIRES_CONFIRMATION`: a person must confirm it before it can be relied on.

## 8. Approval policies

- Submission always needs an approved `BID_SUBMISSION` approval from an
  owner or admin. Operators and viewers cannot decide.
- Rejecting requires a reason. Decisions are final and audited.
- One pending approval per task (unique index). Expired approvals cannot be
  decided.
- TenderOS never auto-submits. In simulation mode the submission is a record
  with a package hash; nothing leaves the system.

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
  actor). Updates and deletes are rejected by trigger.
- Process logs use `lib/log.ts`: JSON lines with secret redaction. Never log
  tokens, keys, document contents or personal data.

## 11. Model-selection policy

- Each agent has a cost tier (LOW / MID / HIGH). `selectModel` maps tier to a
  model from `AI_MODEL_LOW`, `AI_MODEL_MID`, `AI_MODEL_HIGH`; high-value or
  complex work moves up one tier. An agent can carry a `model_override`.
- No model names are hard-coded. Unset tiers mean "not configured", and real
  execution must refuse to run rather than fall back silently.
- Simulation mode makes no AI calls and records cost as $0 with
  `is_simulated = true`.
- The daily AI budget blocks non-simulated work once spent.

## 12. Security restrictions

- RLS on every table; the service role key and `DATABASE_URL` are server-only.
- Writes from users go through role-checked RPCs; agents write through the
  worker only.
- Per-request nonce CSP, HSTS in production, frame-ancestors none.
- Rate limits on sensitive actions (`hit_rate_limit`).
- Secrets live in environment variables, never in the repo.

See `docs/security.md` for the full model.

## 13. Anti-hallucination requirements

- Never invent company facts, tender facts, prices, certificates, references
  or deadlines. If it is not in the source data, mark it
  `MISSING_INFORMATION` or `REQUIRES_CONFIRMATION`.
- Every output field that came from a document must be traceable to it (when
  document ingestion lands, store the page/section reference).
- Pricing agents structure schedules; they do not produce figures without
  supplier quotations and human input.
- QA treats missing information as an open issue, never as a pass.
- Simulated work is labelled simulated everywhere it appears.
