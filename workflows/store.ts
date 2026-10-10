import type { PoolClient } from "@/lib/db/pool";
import type { Database, Json } from "@/types/database";
import { deriveAgentState, type AgentTaskSnapshot } from "@/lib/domain/agent-status";
import { assertTransition, type TenderStatus } from "@/lib/domain/tender-state";
import type { DataCategory } from "@/agents/registry";
import type { CostRecord, TenderSnapshot } from "@/agents/runtime/types";

type Tables = Database["public"]["Tables"];
export type TaskRow = Tables["tasks"]["Row"];
export type RunRow = Tables["workflow_runs"]["Row"];
export type AgentRow = Tables["agents"]["Row"];
export type TenderRow = Tables["tenders"]["Row"];
export type SettingsRow = Tables["system_settings"]["Row"];
export type Severity = Database["public"]["Enums"]["event_severity"];

export const ACTIVE_RUN_STATUSES = ["PENDING", "RUNNING", "WAITING_APPROVAL", "BLOCKED"] as const;

export class LoopGuardError extends Error {
  constructor(runId: string, max: number) {
    super(`Workflow ${runId} reached its maximum of ${max} tasks`);
    this.name = "LoopGuardError";
  }
}

export interface EventInput {
  organisationId: string;
  type: string;
  summary: string;
  severity?: Severity;
  agentId?: string | null;
  tenderId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  handoffId?: string | null;
  approvalId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  payload?: Record<string, unknown>;
}

export async function emitEvent(c: PoolClient, e: EventInput): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into public.agent_events
       (organisation_id, event_type, severity, agent_id, tender_id, task_id, workflow_run_id,
        handoff_id, approval_id, correlation_id, causation_id, summary, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      e.organisationId,
      e.type,
      e.severity ?? "INFO",
      e.agentId ?? null,
      e.tenderId ?? null,
      e.taskId ?? null,
      e.runId ?? null,
      e.handoffId ?? null,
      e.approvalId ?? null,
      e.correlationId ?? null,
      e.causationId ?? null,
      e.summary.slice(0, 500),
      JSON.stringify(e.payload ?? {}),
    ],
  );
  return rows[0].id;
}

export async function audit(
  c: PoolClient,
  organisationId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
  correlationId: string | null = null,
): Promise<void> {
  await c.query(`select private.write_audit($1, $2, $3, $4, $5::jsonb, $6)`, [
    organisationId,
    action,
    resourceType,
    resourceId,
    JSON.stringify(metadata),
    correlationId,
  ]);
}

export async function lockTask(c: PoolClient, id: string): Promise<TaskRow | null> {
  const { rows } = await c.query<TaskRow>(`select * from public.tasks where id = $1 for update`, [id]);
  return rows[0] ?? null;
}

export async function lockRun(c: PoolClient, id: string): Promise<RunRow | null> {
  const { rows } = await c.query<RunRow>(`select * from public.workflow_runs where id = $1 for update`, [id]);
  return rows[0] ?? null;
}

export async function getAgent(c: PoolClient, id: string): Promise<AgentRow> {
  const { rows } = await c.query<AgentRow>(`select * from public.agents where id = $1`, [id]);
  if (!rows[0]) throw new Error(`Agent ${id} not found`);
  return rows[0];
}

export async function getAgentBySlug(c: PoolClient, organisationId: string, slug: string): Promise<AgentRow> {
  const { rows } = await c.query<AgentRow>(`select * from public.agents where organisation_id = $1 and slug = $2`, [organisationId, slug]);
  if (!rows[0]) throw new Error(`Agent ${slug} not found in organisation`);
  return rows[0];
}

export async function getAgentGrants(c: PoolClient, agentId: string): Promise<DataCategory[]> {
  const { rows } = await c.query<{ data_category: DataCategory }>(
    `select data_category from public.agent_permissions where agent_id = $1`,
    [agentId],
  );
  return rows.map((r) => r.data_category);
}

export async function getSettings(c: PoolClient, organisationId: string): Promise<SettingsRow> {
  const { rows } = await c.query<SettingsRow>(`select * from public.system_settings where organisation_id = $1`, [organisationId]);
  if (!rows[0]) throw new Error(`Settings missing for organisation ${organisationId}`);
  return rows[0];
}

export async function getTender(c: PoolClient, id: string, lock = false): Promise<TenderRow> {
  const { rows } = await c.query<TenderRow>(`select * from public.tenders where id = $1 ${lock ? "for update" : ""}`, [id]);
  if (!rows[0]) throw new Error(`Tender ${id} not found`);
  return rows[0];
}

export function toTenderSnapshot(t: TenderRow): TenderSnapshot {
  return {
    id: t.id,
    reference_number: t.reference_number,
    title: t.title,
    issuing_organisation: t.issuing_organisation,
    description: t.description,
    province: t.province,
    sector: t.sector,
    estimated_value_zar: t.estimated_value_zar,
    published_at: t.published_at,
    closing_at: t.closing_at,
    briefing_at: t.briefing_at,
    briefing_compulsory: t.briefing_compulsory,
    briefing_location: t.briefing_location,
    questions_deadline_at: t.questions_deadline_at,
    submission_method: t.submission_method,
    submission_destination: t.submission_destination,
    source_url: t.source_url,
    is_simulation: t.is_simulation,
  };
}

/** Checkpointed outputs of completed steps in a run, keyed by step key. */
export async function getPreviousOutputs(c: PoolClient, runId: string): Promise<Record<string, unknown>> {
  const { rows } = await c.query<{ step_key: string; output: unknown }>(
    `select distinct on (step_key) step_key, output from public.tasks
      where workflow_run_id = $1 and status = 'COMPLETED' and step_key is not null
      order by step_key, completed_at desc`,
    [runId],
  );
  return Object.fromEntries(rows.map((r) => [r.step_key, r.output]));
}

/**
 * Applies a sequence of tender transitions, skipping any the tender is already
 * in (idempotent on replay). The DB trigger validates each transition and
 * writes tender_status_history.
 */
export async function transitionTender(
  c: PoolClient,
  ctx: { organisationId: string; tenderId: string; agentId: string | null; runId: string; correlationId: string },
  targets: TenderStatus[],
  reason: string,
): Promise<TenderStatus> {
  const tender = await getTender(c, ctx.tenderId, true);
  let current = tender.status as TenderStatus;
  for (const to of targets) {
    if (current === to) continue;
    assertTransition(current, to);
    await c.query(`select set_config('app.transition_reason', $1, true)`, [reason.slice(0, 500)]);
    await c.query(`update public.tenders set status = $2 where id = $1`, [ctx.tenderId, to]);
    await emitEvent(c, {
      organisationId: ctx.organisationId,
      type: "TENDER_STATUS_CHANGED",
      summary: `Tender moved from ${current} to ${to}`,
      agentId: ctx.agentId,
      tenderId: ctx.tenderId,
      runId: ctx.runId,
      correlationId: ctx.correlationId,
      payload: { from: current, to, reason },
    });
    current = to;
  }
  return current;
}

export interface NewTask {
  organisationId: string;
  run: RunRow;
  agentId: string;
  stepKey: string;
  type: string;
  title: string;
  description?: string;
  status?: TaskRow["status"];
  priority?: number;
  input?: Record<string, unknown>;
  parentTaskId?: string | null;
  maxRetries: number;
  timeoutSeconds?: number;
  approvalRequired?: boolean;
}

/** Creates a task, enforcing the per-run task budget (loop protection). Idempotent per run+step. */
export async function createTask(c: PoolClient, t: NewTask): Promise<TaskRow> {
  const key = `${t.run.id}:${t.stepKey}`;
  const existing = await c.query<TaskRow>(
    `select * from public.tasks where organisation_id = $1 and idempotency_key = $2`,
    [t.organisationId, key],
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows: counter } = await c.query<{ task_count: number; max_tasks: number }>(
    `update public.workflow_runs set task_count = task_count + 1
      where id = $1 and task_count < max_tasks returning task_count, max_tasks`,
    [t.run.id],
  );
  if (!counter[0]) throw new LoopGuardError(t.run.id, t.run.max_tasks);

  const { rows } = await c.query<TaskRow>(
    `insert into public.tasks
       (organisation_id, workflow_run_id, tender_id, agent_id, parent_task_id, type, step_key, title, description,
        status, priority, input, max_retries, timeout_seconds, approval_required, idempotency_key, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [
      t.organisationId,
      t.run.id,
      t.run.tender_id,
      t.agentId,
      t.parentTaskId ?? null,
      t.type,
      t.stepKey,
      t.title,
      t.description ?? "",
      t.status ?? "QUEUED",
      t.priority ?? 5,
      JSON.stringify(t.input ?? {}),
      t.maxRetries,
      t.timeoutSeconds ?? 300,
      t.approvalRequired ?? false,
      key,
      t.run.correlation_id,
    ],
  );
  const task = rows[0];
  await emitEvent(c, {
    organisationId: t.organisationId,
    type: "TASK_CREATED",
    summary: `Task created: ${t.title}`,
    agentId: t.agentId,
    tenderId: t.run.tender_id,
    taskId: task.id,
    runId: t.run.id,
    correlationId: t.run.correlation_id,
    payload: { step: t.stepKey, type: t.type },
  });
  return task;
}

export async function createHandoff(
  c: PoolClient,
  h: {
    organisationId: string;
    run: RunRow;
    fromAgentId: string | null;
    toAgentId: string;
    fromTaskId: string | null;
    toTaskId: string;
    toApproval?: boolean;
    type: string;
    payload: Record<string, unknown>;
    fromName?: string;
    toName: string;
  },
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into public.handoffs
       (organisation_id, workflow_run_id, tender_id, from_agent_id, to_agent_id, from_task_id, to_task_id,
        to_approval, handoff_type, payload, correlation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      h.organisationId,
      h.run.id,
      h.run.tender_id,
      h.fromAgentId,
      h.toAgentId,
      h.fromTaskId,
      h.toTaskId,
      h.toApproval ?? false,
      h.type,
      JSON.stringify(h.payload),
      h.run.correlation_id,
    ],
  );
  const id = rows[0].id;
  await emitEvent(c, {
    organisationId: h.organisationId,
    type: "HANDOFF_CREATED",
    summary: `${h.fromName ?? "System"} handed off to ${h.toName}${h.toApproval ? " (approval)" : ""}`,
    agentId: h.fromAgentId,
    tenderId: h.run.tender_id,
    taskId: h.toTaskId,
    runId: h.run.id,
    handoffId: id,
    correlationId: h.run.correlation_id,
    payload: { handoff_type: h.type, from_agent_id: h.fromAgentId, to_agent_id: h.toAgentId, to_approval: h.toApproval ?? false },
  });
  return id;
}

export async function acceptHandoffFor(c: PoolClient, task: TaskRow, agentName: string): Promise<void> {
  const { rows } = await c.query<{ id: string; from_agent_id: string | null }>(
    `update public.handoffs set status = 'ACCEPTED', accepted_at = now()
      where to_task_id = $1 and status = 'PENDING' returning id, from_agent_id`,
    [task.id],
  );
  for (const h of rows) {
    await emitEvent(c, {
      organisationId: task.organisation_id,
      type: "HANDOFF_ACCEPTED",
      summary: `${agentName} accepted the handoff`,
      agentId: task.agent_id,
      tenderId: task.tender_id,
      taskId: task.id,
      runId: task.workflow_run_id,
      handoffId: h.id,
      correlationId: task.correlation_id,
      payload: { from_agent_id: h.from_agent_id },
    });
  }
}

export async function enqueueJob(
  c: PoolClient,
  organisationId: string,
  kind: string,
  payload: Record<string, unknown>,
  dedupeKey: string | null = null,
  runAt: Date = new Date(),
): Promise<void> {
  await c.query(`select private.enqueue_job($1, $2, $3::jsonb, $4, $5)`, [
    organisationId,
    kind,
    JSON.stringify(payload),
    dedupeKey,
    runAt.toISOString(),
  ]);
}

export async function notifyMembers(
  c: PoolClient,
  organisationId: string,
  kind: string,
  severity: Severity,
  title: string,
  body: string | null,
  link: string | null,
): Promise<void> {
  await c.query(`select private.notify_members($1, $2, $3, $4, $5, $6)`, [organisationId, kind, severity, title, body, link]);
}

export async function recordCost(c: PoolClient, task: TaskRow, cost: CostRecord): Promise<void> {
  await c.query(
    `insert into public.cost_usage
       (organisation_id, agent_id, task_id, tender_id, workflow_run_id, provider, model, input_tokens, output_tokens, cost_usd, is_simulated)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      task.organisation_id,
      task.agent_id,
      task.id,
      task.tender_id,
      task.workflow_run_id,
      cost.provider,
      cost.model,
      cost.inputTokens,
      cost.outputTokens,
      cost.costUsd,
      cost.isSimulated,
    ],
  );
  if (cost.costUsd > 0) {
    await c.query(`update public.tasks set actual_cost_usd = actual_cost_usd + $2 where id = $1`, [task.id, cost.costUsd]);
  }
}

export async function spendToday(c: PoolClient, organisationId: string): Promise<number> {
  const { rows } = await c.query<{ total: number | null }>(
    `select coalesce(sum(cost_usd), 0) as total from public.cost_usage
      where organisation_id = $1 and created_at >= date_trunc('day', now())`,
    [organisationId],
  );
  return Number(rows[0]?.total ?? 0);
}

/** Recomputes an agent's displayed state from its tasks. */
export async function refreshAgent(c: PoolClient, agentId: string): Promise<void> {
  const { rows: agentRows } = await c.query<AgentRow>(`select * from public.agents where id = $1 for update`, [agentId]);
  const agent = agentRows[0];
  if (!agent) return;
  const { rows: tasks } = await c.query<AgentTaskSnapshot>(
    `select t.id, t.tender_id, t.status, t.priority, t.created_at, t.blocked_reason,
            coalesce(r.status in ('PENDING','RUNNING','WAITING_APPROVAL','BLOCKED'), false) as run_active
       from public.tasks t left join public.workflow_runs r on r.id = t.workflow_run_id
      where t.agent_id = $1
        and (t.status in ('QUEUED','RUNNING','WAITING','BLOCKED','NEEDS_APPROVAL')
             or t.created_at > now() - interval '7 days')
      order by t.created_at desc limit 50`,
    [agentId],
  );
  const d = deriveAgentState(agent.status, tasks);
  if (
    d.status !== agent.status ||
    d.currentTaskId !== agent.current_task_id ||
    d.currentTenderId !== agent.current_tender_id ||
    (d.reason ?? null) !== (agent.status_reason ?? null)
  ) {
    await c.query(
      `update public.agents set status = $2::public.agent_status, current_task_id = $3, current_tender_id = $4, status_reason = $5,
              next_expected_action = case when $2::public.agent_status = 'IDLE' then null else next_expected_action end
        where id = $1`,
      [agentId, d.status, d.currentTaskId, d.currentTenderId, d.reason],
    );
  }
}

export async function setAgentActivity(c: PoolClient, agentId: string, last: string, next: string | null): Promise<void> {
  await c.query(`update public.agents set last_action = $2, last_action_at = now(), next_expected_action = $3 where id = $1`, [
    agentId,
    last.slice(0, 300),
    next,
  ]);
}

export function json(value: unknown): Json {
  return value as Json;
}
