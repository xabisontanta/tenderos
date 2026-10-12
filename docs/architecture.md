# Architecture

## Overview

TenderOS has three runtime parts.

1. **Web app** (Next.js App Router). Server components read through the
   Supabase client as the signed-in user, so RLS applies to every query.
   Server actions validate input with zod, rate-limit, and call
   role-checked Postgres RPCs. A single realtime channel per organisation
   streams row changes to the client.
2. **Postgres** (Supabase). Holds all state: organisations, agents, tenders,
   workflow runs, tasks, handoffs, approvals, events, audit logs, costs and the
   job queue. Business invariants live here as well as in TypeScript: the
   tender state machine trigger, one active run per tender, one pending
   approval per task, append-only logs.
3. **Worker** (`scripts/worker.ts`). Connects directly to Postgres, claims
   jobs with `FOR UPDATE SKIP LOCKED`, wakes on `LISTEN tenderos_jobs`, and
   hands each job to the `WorkflowEngine`. Heartbeats go to
   `worker_heartbeats` so the UI can say whether agents are online.

## A workflow run, step by step

1. A user presses Start. `start_tender_workflow` checks role, kill switch,
   simulation mode and tender status, creates a `workflow_runs` row and
   enqueues `workflow.start`.
2. The engine schedules the first step: a task for the Tender Director and a
   handoff from "System". It enqueues `task.run`.
3. For each `task.run` the engine locks the task and run, checks the kill
   switch, agent state, budget and permissions, marks the task `RUNNING`,
   accepts the incoming handoff, runs the executor (reporting progress), and
   validates the output against the executor's zod schema.
4. `resolve()` in the workflow definition decides what comes next. The engine
   stores the output, transitions the tender, emits events, creates the next
   task and handoff, and enqueues the next job, in one transaction.
5. At the approval step the run waits (`WAITING_APPROVAL`). An owner or admin
   decides on the Approvals page; `decide_approval` enqueues
   `approval.decided`.
6. On approval the Submission Officer records a simulated submission with a
   package hash. The tender becomes `SUBMITTED` and the run completes.

Failures retry with backoff, then block the run and notify people. See
`AGENTS.md` §9.

## Executors and AI

Each step's executor is chosen per task by
`getExecutor(taskType, { simulation, aiEnabled })` in `agents/index.ts`.
Simulation runs and real tenders with AI off use `simulated.ts` (rules only,
the default). A real tender with AI on uses `real.ts` for five steps: Tender
Analyst, Qualification fit, Proposal Writer, Pricing Analyst and QA Reviewer.

Before such a step starts, the engine loads the AI configuration (it refuses
to run if the key, the agent's model or its price is missing), caps the task at
what is left of the daily budget, and builds the AI runtime: an injectable model
client (`AnthropicAiClient` in production, a deterministic fake in tests), a cost
meter, a tool gate that enforces the agent's stored `allowedTools`, and a source
of tender documents. The executor returns real token counts and USD cost, which
the engine records in `cost_usage`, so the daily budget gate sees real numbers.
Failed attempts record their spend too. `docs/ai-agents.md` describes each
agent, the guardrails and the evaluation harness.

## Views

- **Dashboard**: pipeline counts, agents, spend, active runs, deadlines, live events.
- **Office**: departments as rooms and agents as desks. Desk state comes from
  agent rows; lines are drawn only for `HANDOFF_CREATED` events.
- **Operations**: React Flow graph of the pipeline with live agent state,
  problems, approvals, errors, handoffs, deadline risks.
- **Tenders**, **Tender detail**, **Agent detail**, **Approvals**,
  **Activity**, **Settings**.

## File structure

```
app/                     Next.js routes
  (auth)/                login, signup
  (app)/                 authenticated shell: dashboard, office, operations,
                         tenders, agents/[id], approvals, activity, settings
  onboarding/            create organisation
  auth/callback/         Supabase auth callback
agents/
  registry.ts            departments and agents (single source of truth)
  runtime/               executor types, permissions, model routing, simulation,
                         tool gate (allowedTools enforcement)
  runtime/ai/            Anthropic client, config and pricing, structured output,
                         guardrails (untrusted text, citations, data policy),
                         company facts, documents, call logging, web research
  <agent>/               schema.ts, logic.ts, simulated.ts per executor, and
                         real.ts for the five AI-backed steps
  index.ts               executor lookup (simulated by default, AI by mode)
workflows/
  definitions/           workflow plans and step resolution
  engine.ts              WorkflowEngine (job handlers)
  store.ts               transactional data access for the engine
  worker.ts              queue consumer, heartbeats
  retry.ts               backoff policy
connectors/              tender source connector interface (manual for now)
components/ui/           shadcn-style primitives
components/command-centre/ shared app components (badges, feed, avatars)
features/<area>/         feature components and server actions
lib/
  domain/                tender state machine, agent status, event types
  data/                  request context and queries
  supabase/              browser, server, admin and middleware clients
  security/              CSP
  db/                    pg pool for the worker
supabase/migrations/     schema, RLS, RPCs (ordered)
scripts/                 worker entry point, env writer
tests/unit, tests/integration, tests/e2e
tests/eval/              labelled synthetic tenders, fake-model runner, live eval
tests/support/           fake AI client, fake document source, context builders
types/database.ts        generated from the database
```
