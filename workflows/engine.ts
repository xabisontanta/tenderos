import type { Pool, PoolClient } from "@/lib/db/pool";
import { withTx } from "@/lib/db/pool";
import type { Logger } from "@/lib/log";
import { getExecutor } from "@/agents";
import { getAgentDefinition } from "@/agents/registry";
import { authoriseExecutor } from "@/agents/runtime/permissions";
import { createToolGate } from "@/agents/runtime/tool-access";
import { NonRetryableError, type AgentContext, type AgentResult, type CostRecord, type SimulationOptions } from "@/agents/runtime/types";
import { createAnthropicClient } from "@/agents/runtime/ai/anthropic";
import type { AiClient } from "@/agents/runtime/ai/client";
import { loadAiConfig, resolveAiEnabled, resolveModel, resolveWebResearchEnabled, withTaskCostCeiling, type AiConfig } from "@/agents/runtime/ai/config";
import type { DocumentSource } from "@/agents/runtime/ai/documents";
import { createAiRuntime, type AiRuntime } from "@/agents/runtime/ai/runtime";
import { backoffMs, shouldRetry } from "./retry";
import { WORKFLOWS, getStep, type StepResolution, type WorkflowDefinition } from "./definitions/simulated-bid";
import type { PlanStep } from "./definitions/plan";
import * as db from "./store";
import { runDiscovery } from "./discovery";
import { maxInvalidRatioFromEnv, type Fetcher } from "@/agents/discovery/etenders";
import { ingestTenderDocuments, productionIngestDeps, type IngestDeps } from "@/lib/tender-documents/ingest";
import { createTenderDocumentSource } from "@/lib/tender-documents/source";
import { createSupabaseStorage, type DocumentStorage } from "@/lib/tender-documents/storage";

export interface Job {
  id: number;
  organisation_id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobOutcome =
  | { status: "completed" }
  | { status: "retry"; runAt: Date; error: string }
  | { status: "defer"; runAt: Date; reason: string }
  | { status: "dead"; error: string };

export interface EngineOptions {
  simulationStepMs: number;
  logger: Logger;
  now?: () => Date;
  /** Minimum interval between persisted progress updates. */
  progressThrottleMs?: number;
  /** HTTP client for tender source connectors. Defaults to global fetch. */
  fetcher?: Fetcher;
  /** Share of the portal's rows a scan may fail to read before it fails (default: DISCOVERY_MAX_INVALID_PCT, else 20 percent). */
  discovery?: { maxInvalidRatio?: number };
  ai?: EngineAiOptions;
  /** Tender document fetching (the `tender.documents.fetch` job and the Tender Analyst's documents). Tests inject fakes. */
  documents?: EngineDocumentOptions;
}

export interface EngineDocumentOptions {
  /** Downloads one document. Defaults to the hardened HTTPS fetcher. */
  fetch?: IngestDeps["fetch"];
  /** The private tender-documents bucket. Defaults to Supabase Storage with the service role key from the environment. */
  storage?: DocumentStorage;
  /** Hosts documents may come from besides the tender's own. Defaults to TENDER_DOCUMENT_HOSTS. */
  allowedHosts?: readonly string[];
}

/** Wiring for AI execution. Everything defaults to production behaviour; tests inject fakes. */
export interface EngineAiOptions {
  /** Environment to read AI settings from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Model client. Defaults to the Anthropic client built from the environment. */
  client?: AiClient;
  /** Where the Tender Analyst reads tender documents from. Defaults to the organisation's fetched PDFs (lib/tender-documents/source.ts). */
  documents?: DocumentSource;
}

const DEFER_PAUSED_MS = 30_000;
const DEFER_KILL_SWITCH_MS = 60_000;
const DEFER_CAPACITY_MS = 5_000;

/**
 * The workflow engine. Each job is handled in short transactions around the
 * agent execution so that state is checkpointed, every change emits an event,
 * and a crash at any point leaves the run resumable.
 */
export class WorkflowEngine {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly opts: EngineOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async handle(job: Job): Promise<JobOutcome> {
    switch (job.kind) {
      case "workflow.start":
        return this.startWorkflow(String(job.payload.workflow_run_id));
      case "task.run":
        return this.runTask(String(job.payload.task_id));
      case "discovery.run":
        return runDiscovery(this.pool, String(job.payload.discovery_run_id), job.attempts, {
          fetcher: this.opts.fetcher ?? (globalThis.fetch as unknown as Fetcher),
          logger: this.opts.logger,
          now: this.now,
          maxInvalidRatio: this.opts.discovery?.maxInvalidRatio ?? maxInvalidRatioFromEnv(process.env),
        });
      case "tender.documents.fetch":
        return this.fetchTenderDocuments(job);
      case "approval.decided":
        return this.approvalDecided(String(job.payload.approval_id));
      case "agents.refresh":
        return this.refreshRunAgents(String(job.payload.workflow_run_id));
      default:
        return { status: "dead", error: `Unknown job kind ${job.kind}` };
    }
  }

  /**
   * Called when a job crashed on every attempt. For task jobs the task is
   * failed and the run blocked; for other run jobs the run is blocked; a dead
   * scan is marked failed. Nothing is left silently RUNNING.
   */
  async onJobDead(job: Job, error: string): Promise<void> {
    if ((job.kind === "workflow.start" || job.kind === "approval.decided") && job.payload.workflow_run_id) {
      await withTx(this.pool, async (c) => {
        const run = await db.lockRun(c, String(job.payload.workflow_run_id));
        if (!run || !["PENDING", "RUNNING", "WAITING_APPROVAL"].includes(run.status)) return;
        await this.blockRun(c, run, `System error: ${error}`.slice(0, 1000), null);
      });
      return;
    }
    if (job.kind === "discovery.run" && job.payload.discovery_run_id) {
      await this.pool.query(
        `update public.discovery_runs set status = 'FAILED', error = $2, completed_at = now() where id = $1 and status in ('QUEUED', 'RUNNING')`,
        [String(job.payload.discovery_run_id), `System error: ${error}`.slice(0, 1000)],
      );
      return;
    }
    if (job.kind === "tender.documents.fetch" && job.payload.tender_id) {
      // Nothing should stay "waiting" for a job that will never run again: show the reason on the documents.
      await this.pool.query(`update public.tender_documents set status = 'FAILED', error = $2 where tender_id = $1 and status = 'PENDING'`, [
        String(job.payload.tender_id),
        `The fetch stopped: ${error}`.slice(0, 500),
      ]);
      return;
    }
    if (job.kind !== "task.run") return;
    await withTx(this.pool, async (c) => {
      const task = await db.lockTask(c, String(job.payload.task_id));
      if (!task || !["RUNNING", "QUEUED", "WAITING"].includes(task.status) || !task.workflow_run_id) return;
      const run = await db.lockRun(c, task.workflow_run_id);
      if (!run) return;
      const agent = await db.getAgent(c, task.agent_id);
      const step = getStep(this.definition(run), task.step_key!);
      await this.failTaskPermanently(c, task, run, agent, step, `System error: ${error}`);
    });
  }

  // -------------------------------------------------------------------------
  private ingestDeps(): IngestDeps {
    const o = this.opts.documents;
    const storage = o?.storage ?? createSupabaseStorage(this.opts.ai?.env ?? process.env);
    const base = o?.fetch ? { fetch: o.fetch, storage, logger: this.opts.logger } : productionIngestDeps(this.opts.logger, storage);
    return o?.allowedHosts ? { ...base, allowedHosts: o.allowedHosts } : base;
  }

  /** Fetches a tender's pending documents. Per-document outcomes are recorded on the rows; the job only decides whether to come back. */
  private async fetchTenderDocuments(job: Job): Promise<JobOutcome> {
    const res = await ingestTenderDocuments(this.pool, String(job.payload.tender_id), this.ingestDeps());
    const later = (ms: number) => new Date(this.now().getTime() + ms);
    if (res.busy) return { status: "defer", runAt: later(5_000), reason: "Another run is fetching this tender's documents" };
    if (res.retrying > 0) return { status: "retry", runAt: later(backoffMs(job.attempts)), error: "Some documents will be tried again" };
    if (res.remaining > 0) return { status: "defer", runAt: later(2_000), reason: "More documents to fetch" };
    return { status: "completed" };
  }

  private definition(run: db.RunRow): WorkflowDefinition {
    const def = WORKFLOWS[run.workflow_key];
    if (!def) throw new NonRetryableError(`Unknown workflow ${run.workflow_key}`);
    return def;
  }

  private async startWorkflow(runId: string): Promise<JobOutcome> {
    await withTx(this.pool, async (c) => {
      const run = await db.lockRun(c, runId);
      if (!run || run.status !== "PENDING") return;
      const def = this.definition(run);
      await c.query(`update public.workflow_runs set status = 'RUNNING', started_at = now(), workflow_version = $2 where id = $1`, [run.id, def.version]);
      await db.emitEvent(c, {
        organisationId: run.organisation_id,
        type: "WORKFLOW_STARTED",
        summary: `Workflow ${def.key} started${run.is_simulation ? " (simulation)" : ""}`,
        tenderId: run.tender_id,
        runId: run.id,
        correlationId: run.correlation_id,
        payload: { workflow_key: def.key, version: def.version, steps: def.steps.map((s) => s.key) },
      });
      await db.audit(c, run.organisation_id, "workflow.started", "workflow_run", run.id, { workflow_key: def.key }, run.correlation_id);
      // A bid prepared again (rerun_bid) starts at the step named in its options.
      const startStep = (run.options as { start_step?: string } | null)?.start_step;
      const first = startStep && def.steps.some((s) => s.key === startStep) ? startStep : def.firstStep;
      await this.scheduleStep(c, run, def, getStep(def, first), { tender_id: run.tender_id }, null);
    });
    return { status: "completed" };
  }

  /** Creates the task (and approval, for approval steps) for a step, plus the handoff into it. */
  private async scheduleStep(
    c: PoolClient,
    run: db.RunRow,
    def: WorkflowDefinition,
    step: PlanStep,
    payload: Record<string, unknown>,
    from: { task: db.TaskRow; agent: db.AgentRow } | null,
  ): Promise<void> {
    const settings = await db.getSettings(c, run.organisation_id);
    const agent = await db.getAgentBySlug(c, run.organisation_id, step.agent);
    const isApproval = step.kind === "approval";

    const task = await db.createTask(c, {
      organisationId: run.organisation_id,
      run,
      agentId: agent.id,
      stepKey: step.key,
      type: step.taskType,
      title: step.title,
      description: isApproval ? "Waiting for a human to approve the bid submission" : "",
      status: isApproval ? "NEEDS_APPROVAL" : "QUEUED",
      priority: step.priority ?? 5,
      input: payload,
      parentTaskId: from?.task.id ?? null,
      maxRetries: settings.default_max_retries,
      timeoutSeconds: step.timeoutSeconds ?? 300,
      approvalRequired: isApproval,
    });

    // After an approval gate the work comes from the human decision, not the gate's owner.
    const fromApproval = from?.task.approval_required === true;
    await db.createHandoff(c, {
      organisationId: run.organisation_id,
      run,
      fromAgentId: fromApproval ? null : (from?.agent.id ?? null),
      fromApproval,
      toAgentId: agent.id,
      fromTaskId: from?.task.id ?? null,
      toTaskId: task.id,
      toApproval: isApproval,
      type: step.handoffType,
      payload,
      fromName: from?.agent.display_name,
      toName: agent.display_name,
    });

    if (isApproval) {
      await this.requestApproval(c, run, task, agent, payload);
    } else {
      await db.enqueueJob(c, run.organisation_id, "task.run", { task_id: task.id }, `task.run:${task.id}`);
      await db.setAgentActivity(c, agent.id, agent.last_action ?? "Waiting for work", `Start: ${step.title}`);
    }
    await c.query(`update public.workflow_runs set current_step = $2 where id = $1`, [run.id, step.key]);
    await db.refreshAgent(c, agent.id);
  }

  private async requestApproval(c: PoolClient, run: db.RunRow, task: db.TaskRow, agent: db.AgentRow, payload: Record<string, unknown>) {
    const tender = await db.getTender(c, run.tender_id);
    const openIssues = Array.isArray(payload.open_issues) ? (payload.open_issues as string[]) : [];
    const summary = `Approve ${run.is_simulation ? "simulated " : ""}submission of "${tender.title}"${
      openIssues.length ? ` with ${openIssues.length} open QA issues` : ""
    }`;
    const { rows } = await c.query<{ id: string }>(
      `insert into public.approvals (organisation_id, type, requested_by_agent_id, tender_id, task_id, workflow_run_id,
                                     summary, risk_level, payload, expires_at)
       values ($1, 'BID_SUBMISSION', $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        run.organisation_id,
        agent.id,
        tender.id,
        task.id,
        run.id,
        summary.slice(0, 1000),
        openIssues.length ? "HIGH" : "MEDIUM",
        JSON.stringify({ ...payload, closing_at: tender.closing_at, is_simulation: run.is_simulation }),
        tender.closing_at,
      ],
    );
    const approvalId = rows[0].id;
    await c.query(`update public.tasks set approval_id = $2, blocked_reason = 'Awaiting human approval' where id = $1`, [task.id, approvalId]);
    await c.query(`update public.workflow_runs set status = 'WAITING_APPROVAL' where id = $1`, [run.id]);
    await db.setAgentActivity(c, agent.id, "Requested bid submission approval", "Submit once approved");
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "APPROVAL_REQUIRED",
      severity: "WARNING",
      summary,
      agentId: agent.id,
      tenderId: tender.id,
      taskId: task.id,
      runId: run.id,
      approvalId,
      correlationId: run.correlation_id,
      payload: { approval_type: "BID_SUBMISSION", open_issues: openIssues },
    });
    await db.audit(c, run.organisation_id, "approval.requested", "approval", approvalId, { type: "BID_SUBMISSION" }, run.correlation_id);
    await db.notifyMembers(c, run.organisation_id, "APPROVAL_REQUIRED", "WARNING", "Approval required", summary, `/approvals`);
  }

  // -------------------------------------------------------------------------
  private async runTask(taskId: string): Promise<JobOutcome> {
    type Prepared =
      | { kind: "outcome"; outcome: JobOutcome }
      | {
          kind: "run";
          task: db.TaskRow;
          run: db.RunRow;
          agent: db.AgentRow;
          step: PlanStep;
          def: WorkflowDefinition;
          ctxData: Omit<AgentContext, "progress" | "signal" | "tools" | "ai">;
          /** Present when the step runs a model-backed executor. */
          aiSetup: { config: AiConfig; webResearch: boolean } | null;
        };

    const prepared = await withTx<Prepared>(this.pool, async (c) => {
      const task = await db.lockTask(c, taskId);
      if (!task || ["COMPLETED", "CANCELLED", "NEEDS_APPROVAL"].includes(task.status)) {
        return { kind: "outcome", outcome: { status: "completed" } };
      }
      const run = task.workflow_run_id ? await db.lockRun(c, task.workflow_run_id) : null;
      if (!run || !(db.ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
        await c.query(`update public.tasks set status = 'CANCELLED', blocked_reason = 'Workflow no longer active' where id = $1`, [task.id]);
        await db.refreshAgent(c, task.agent_id);
        return { kind: "outcome", outcome: { status: "completed" } };
      }
      const agent = await db.getAgent(c, task.agent_id);
      const settings = await db.getSettings(c, task.organisation_id);
      const def = this.definition(run);
      const step = getStep(def, task.step_key!);

      const wait = async (reason: string, ms: number): Promise<Prepared> => {
        if (task.blocked_reason !== reason || task.status !== "WAITING") {
          await c.query(`update public.tasks set status = 'WAITING', blocked_reason = $2 where id = $1`, [task.id, reason]);
          await db.refreshAgent(c, agent.id);
        }
        return { kind: "outcome", outcome: { status: "defer", runAt: new Date(this.now().getTime() + ms), reason } };
      };

      if (settings.kill_switch) return wait("Emergency kill switch engaged", DEFER_KILL_SWITCH_MS);
      if (agent.status === "PAUSED") return wait("Agent paused by operator", DEFER_PAUSED_MS);
      if (agent.status === "DISABLED") return wait("Agent disabled", DEFER_PAUSED_MS);

      const { rows: busy } = await c.query<{ n: number }>(
        `select count(*)::int as n from public.tasks where agent_id = $1 and status = 'RUNNING' and id <> $2`,
        [agent.id, task.id],
      );
      if (busy[0].n >= agent.max_concurrent_tasks) {
        if (task.status !== "QUEUED") await c.query(`update public.tasks set status = 'QUEUED', blocked_reason = 'Agent at capacity' where id = $1`, [task.id]);
        return { kind: "outcome", outcome: { status: "defer", runAt: new Date(this.now().getTime() + DEFER_CAPACITY_MS), reason: "Agent at capacity" } };
      }

      const daily = Number(settings.daily_ai_budget_usd);
      const spentToday = !run.is_simulation && daily > 0 ? await db.spendToday(c, task.organisation_id) : 0;
      if (!run.is_simulation && daily > 0 && spentToday >= daily) {
        await this.failTaskPermanently(c, task, run, agent, step, "Daily AI budget reached; raise the budget or wait until tomorrow");
        await db.emitEvent(c, {
          organisationId: task.organisation_id,
          type: "BUDGET_WARNING",
          severity: "CRITICAL",
          summary: "Daily AI budget reached; agent work paused",
          runId: run.id,
          tenderId: run.tender_id,
          correlationId: run.correlation_id,
        });
        return { kind: "outcome", outcome: { status: "dead", error: "Daily AI budget reached" } };
      }

      // Rules-only is the default. A model-backed executor needs a real run and AI switched on for the organisation.
      const aiEnv = this.opts.ai?.env ?? process.env;
      const executor = getExecutor(task.type, { simulation: run.is_simulation, aiEnabled: resolveAiEnabled(settings, aiEnv) });
      if (!executor) {
        await this.failTaskPermanently(c, task, run, agent, step, `No executor registered for ${task.type}`);
        return { kind: "outcome", outcome: { status: "dead", error: `No executor for ${task.type}` } };
      }
      let granted;
      let aiSetup: { config: AiConfig; webResearch: boolean } | null = null;
      try {
        granted = authoriseExecutor(executor, await db.getAgentGrants(c, agent.id));
        if (executor.ai) {
          // Refuse before the task starts if the key, the agent's model or its price is not configured. Never fall back silently.
          const loaded = loadAiConfig(aiEnv);
          resolveModel(loaded, { agentTier: agent.model_tier, override: agent.model_override });
          // The task may not spend more than what is left of the day's budget.
          const config = daily > 0 ? withTaskCostCeiling(loaded, daily - spentToday) : loaded;
          aiSetup = { config, webResearch: resolveWebResearchEnabled(settings, aiEnv) };
        }
      } catch (err) {
        await this.failTaskPermanently(c, task, run, agent, step, (err as Error).message);
        return { kind: "outcome", outcome: { status: "dead", error: (err as Error).message } };
      }

      const firstStart = task.status !== "RUNNING";
      await c.query(
        `update public.tasks set status = 'RUNNING', started_at = coalesce(started_at, now()), progress = 0,
                progress_message = 'Starting', error = null, blocked_reason = null where id = $1`,
        [task.id],
      );
      await c.query(`select set_config('app.actor_agent_id', $1, true)`, [agent.id]);
      await db.acceptHandoffFor(c, task, agent.display_name);
      const tenderCtx = { organisationId: task.organisation_id, tenderId: run.tender_id, agentId: agent.id, runId: run.id, correlationId: run.correlation_id };
      if (step.onStart.length) await db.transitionTender(c, tenderCtx, step.onStart, `${agent.display_name} started: ${step.title}`);
      if (run.status === "BLOCKED") await c.query(`update public.workflow_runs set status = 'RUNNING', error = null where id = $1`, [run.id]);

      await db.emitEvent(c, {
        organisationId: task.organisation_id,
        type: "AGENT_STARTED_TASK",
        summary: `${agent.display_name} started: ${task.title}${task.retry_count ? ` (retry ${task.retry_count})` : ""}`,
        agentId: agent.id,
        tenderId: run.tender_id,
        taskId: task.id,
        runId: run.id,
        correlationId: run.correlation_id,
        payload: { step: step.key, attempt: task.retry_count + 1, resumed: !firstStart },
      });
      const nextStep = def.steps[def.steps.findIndex((s) => s.key === step.key) + 1];
      await db.setAgentActivity(
        c,
        agent.id,
        `Started: ${task.title}`,
        nextStep ? `Hand off to ${getAgentDefinition(nextStep.agent)?.displayName ?? nextStep.agent}` : "Complete workflow",
      );
      await db.refreshAgent(c, agent.id);

      const tender = await db.getTender(c, run.tender_id);
      return {
        kind: "run",
        task,
        run,
        agent,
        step,
        def,
        aiSetup,
        ctxData: {
          agentSlug: step.agent,
          task: { id: task.id, type: task.type, stepKey: step.key, input: (task.input ?? {}) as Record<string, unknown>, retryCount: task.retry_count },
          workflow: { runId: run.id, correlationId: run.correlation_id, isSimulation: run.is_simulation, options: (run.options ?? {}) as SimulationOptions },
          tender: granted.has("PUBLIC_TENDER_DATA") ? db.toTenderSnapshot(tender) : null,
          company: granted.has("COMPANY_PROFILE") ? await db.getCompanyProfile(c, run.organisation_id) : null,
          documents: await db.getCompanyDocuments(c, run.organisation_id, [...granted]),
          previousOutputs: await db.getPreviousOutputs(c, run),
          granted,
          now: this.now(),
          simulationStepMs: this.opts.simulationStepMs,
        },
      };
    });

    if (prepared.kind === "outcome") return prepared.outcome;
    const { task, run, agent, step, def, ctxData, aiSetup } = prepared;
    const log = this.opts.logger.child({ task_id: task.id, run_id: run.id, agent: agent.slug, step: step.key });
    const executor = getExecutor(task.type, { simulation: run.is_simulation, aiEnabled: aiSetup !== null })!;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${task.timeout_seconds}s`)), task.timeout_seconds * 1000);
    let lastProgressAt = 0;
    const ctx: AgentContext = {
      ...ctxData,
      ai: null,
      signal: controller.signal,
      // AGENTS.md section 5: a tool that is not on the agent's stored allow-list is refused and logged as a WARNING.
      tools: createToolGate({
        agent: agent.slug,
        allowedTools: agent.allowed_tools,
        onRefused: async (r) => {
          log.warn("tool refused", { tool: r.tool, reason: r.reason });
          await this.emitOutsideTx({
            organisationId: task.organisation_id,
            type: "TOOL_REFUSED",
            severity: "WARNING",
            summary: `${agent.display_name} was refused tool "${r.tool}"${r.reason === "NOT_ON_ALLOWED_LIST" ? ": not on its allowed tools" : ": switched off for this organisation"}`,
            agentId: agent.id,
            tenderId: run.tender_id,
            taskId: task.id,
            runId: run.id,
            correlationId: run.correlation_id,
            payload: { tool: r.tool, reason: r.reason },
          });
        },
      }),
      progress: async (percent, message) => {
        const t = Date.now();
        if (t - lastProgressAt < (this.opts.progressThrottleMs ?? 250) && percent < 100) return;
        lastProgressAt = t;
        await this.pool.query(`update public.tasks set progress = $2, progress_message = $3 where id = $1 and status = 'RUNNING'`, [
          task.id,
          Math.max(0, Math.min(99, Math.round(percent))),
          message.slice(0, 200),
        ]);
        await this.pool.query(`update public.agents set last_action = $2, last_action_at = now() where id = $1`, [agent.id, message.slice(0, 300)]);
      },
    };

    let result: AgentResult<unknown>;
    let ai: AiRuntime | null = null;
    try {
      if (aiSetup) {
        ai = createAiRuntime({
          client: this.opts.ai?.client ?? createAnthropicClient(aiSetup.config),
          config: aiSetup.config,
          agent: { slug: agent.slug as AiRuntime["agent"]["slug"], tier: agent.model_tier, modelOverride: agent.model_override },
          logger: log,
          documents: this.opts.ai?.documents ?? createTenderDocumentSource({ pool: this.pool, ingest: this.ingestDeps() }),
          signal: controller.signal,
          webResearchEnabled: aiSetup.webResearch,
        });
        ctx.ai = ai;
      }
      const raw = await executor.run(ctx);
      const parsed = executor.outputSchema.safeParse(raw.output);
      if (!parsed.success)
        throw new Error(`Output failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      result = { ...raw, output: parsed.data };
    } catch (err) {
      clearTimeout(timeout);
      log.warn("task failed", { error: (err as Error).message });
      // Money spent on calls that did not produce a usable result still counts against the budget.
      const spent = ai && ai.meter.costUsd > 0 ? ai.meter.toCostRecord() : null;
      return this.handleTaskFailure(task.id, err as Error, spent);
    }
    clearTimeout(timeout);

    await withTx(
      this.pool,
      async (c) => {
        const current = await db.lockTask(c, task.id);
        if (!current || current.status !== "RUNNING") return; // cancelled meanwhile
        const lockedRun = await db.lockRun(c, run.id);
        if (!lockedRun || !(db.ACTIVE_RUN_STATUSES as readonly string[]).includes(lockedRun.status)) return;

        await c.query(
          `update public.tasks set status = 'COMPLETED', output = $2, progress = 100, progress_message = $3,
                  completed_at = now(), error = null where id = $1`,
          [task.id, JSON.stringify(result.output), result.summary.slice(0, 200)],
        );
        if (result.cost) {
          // Rule-based steps on a real tender are not simulated work: record them as $0 rules, not simulation.
          const cost = !run.is_simulation && result.cost.provider === "simulation" ? { ...result.cost, provider: "rules", isSimulated: false } : result.cost;
          await db.recordCost(c, current, cost);
        }
        await db.emitEvent(c, {
          organisationId: task.organisation_id,
          type: "AGENT_COMPLETED_TASK",
          summary: `${agent.display_name}: ${result.summary}`,
          agentId: agent.id,
          tenderId: run.tender_id,
          taskId: task.id,
          runId: run.id,
          correlationId: run.correlation_id,
          payload: { step: step.key, simulated: run.is_simulation },
        });
        for (const e of result.events ?? []) {
          await db.emitEvent(c, {
            organisationId: task.organisation_id,
            type: e.type,
            summary: e.summary,
            severity: e.severity,
            agentId: agent.id,
            tenderId: run.tender_id,
            taskId: task.id,
            runId: run.id,
            correlationId: run.correlation_id,
            payload: e.payload,
          });
        }
        await db.setAgentActivity(c, agent.id, result.summary, null);

        if (step.key === "submission") await this.recordSubmission(c, lockedRun, current, result.output as Record<string, unknown>);

        const resolution = def.resolve(step.key, result.output, { isSimulation: lockedRun.is_simulation });
        await this.applyResolution(c, lockedRun, def, resolution, { task: current, agent });
        await db.refreshAgent(c, agent.id);
      },
      agent.id,
    );
    log.info("task completed");
    return { status: "completed" };
  }

  /** Writes an event in its own transaction, for things that must be recorded even though the task then fails. */
  private async emitOutsideTx(e: db.EventInput): Promise<void> {
    const c = await this.pool.connect();
    try {
      await db.emitEvent(c, e);
    } finally {
      c.release();
    }
  }

  private async applyResolution(
    c: PoolClient,
    run: db.RunRow,
    def: WorkflowDefinition,
    res: StepResolution,
    from: { task: db.TaskRow; agent: db.AgentRow },
  ): Promise<void> {
    const tenderCtx = {
      organisationId: run.organisation_id,
      tenderId: run.tender_id,
      agentId: from.agent.id,
      runId: run.id,
      correlationId: run.correlation_id,
    };
    if (res.tender.length) await db.transitionTender(c, tenderCtx, res.tender, `${from.agent.display_name} completed: ${from.task.title}`);

    switch (res.next.type) {
      case "step":
        await this.scheduleStep(c, run, def, getStep(def, res.next.key), res.next.payload, from);
        return;
      case "complete":
        await c.query(`update public.workflow_runs set status = 'COMPLETED', outcome = $2, completed_at = now(), current_step = null where id = $1`, [
          run.id,
          res.next.outcome,
        ]);
        await db.emitEvent(c, {
          organisationId: run.organisation_id,
          type: "WORKFLOW_COMPLETED",
          summary: `Workflow completed: ${res.next.outcome.replaceAll("_", " ").toLowerCase()}`,
          tenderId: run.tender_id,
          runId: run.id,
          correlationId: run.correlation_id,
          payload: { outcome: res.next.outcome },
        });
        await db.audit(c, run.organisation_id, "workflow.completed", "workflow_run", run.id, { outcome: res.next.outcome }, run.correlation_id);
        await db.notifyMembers(
          c,
          run.organisation_id,
          "WORKFLOW_COMPLETED",
          "INFO",
          "Workflow completed",
          res.next.outcome.replaceAll("_", " "),
          `/tenders/${run.tender_id}`,
        );
        await this.refreshAgentsInRun(c, run.id);
        return;
      case "block":
        await this.blockRun(c, run, res.next.reason, from.agent.id);
        return;
    }
  }

  private async blockRun(c: PoolClient, run: db.RunRow, reason: string, agentId: string | null) {
    await c.query(`update public.workflow_runs set status = 'BLOCKED', error = $2 where id = $1`, [run.id, reason.slice(0, 1000)]);
    await db.emitEvent(c, {
      organisationId: run.organisation_id,
      type: "WORKFLOW_BLOCKED",
      severity: "ERROR",
      summary: `Workflow blocked: ${reason}`.slice(0, 500),
      agentId,
      tenderId: run.tender_id,
      runId: run.id,
      correlationId: run.correlation_id,
    });
    await db.notifyMembers(c, run.organisation_id, "WORKFLOW_BLOCKED", "ERROR", "Workflow needs attention", reason.slice(0, 2000), `/tenders/${run.tender_id}`);
  }

  private async recordSubmission(c: PoolClient, run: db.RunRow, task: db.TaskRow, output: Record<string, unknown>) {
    const approvalId = String((task.input as Record<string, unknown>)?.approval_id ?? "");
    const tender = await db.getTender(c, run.tender_id);
    const status = output.status === "SUBMITTED" ? "SUBMITTED" : "ACTION_REQUIRED";
    const { rows } = await c.query<{ id: string }>(
      `insert into public.submission_records (organisation_id, tender_id, workflow_run_id, approval_id, method, status,
         is_simulation, package_hash, destination, receipt, submitted_at)
       values ($1,$2,$3,$4,$5,$6::public.submission_status,$7,$8,$9,$10, case when $6::public.submission_status = 'SUBMITTED' then now() end) returning id`,
      [
        run.organisation_id,
        run.tender_id,
        run.id,
        approvalId,
        tender.submission_method,
        status,
        run.is_simulation,
        output.package_hash,
        tender.submission_destination,
        JSON.stringify({ note: output.receipt_note, simulated: run.is_simulation }),
      ],
    );
    await db.audit(
      c,
      run.organisation_id,
      status === "SUBMITTED" ? "submission.completed" : "submission.action_required",
      "submission_record",
      rows[0].id,
      {
        simulated: run.is_simulation,
        package_hash: output.package_hash,
      },
      run.correlation_id,
    );
    if (status === "ACTION_REQUIRED") {
      await db.notifyMembers(
        c,
        run.organisation_id,
        "SUBMISSION_ACTION_REQUIRED",
        "WARNING",
        tender.submission_method === "PHYSICAL"
          ? "Deliver the bid by hand"
          : tender.submission_method === "EMAIL"
            ? "Email the approved bid"
            : "Upload the approved bid",
        String(output.receipt_note),
        `/tenders/${run.tender_id}`,
      );
    } else {
      await db.notifyMembers(
        c,
        run.organisation_id,
        "SUBMISSION_SUCCESS",
        "INFO",
        run.is_simulation ? "Simulated submission recorded" : "Submission completed",
        tender.title,
        `/tenders/${run.tender_id}`,
      );
    }
  }

  private async handleTaskFailure(taskId: string, err: Error, spent: CostRecord | null = null): Promise<JobOutcome> {
    const retryable = !(err instanceof NonRetryableError);
    return withTx(this.pool, async (c) => {
      const task = await db.lockTask(c, taskId);
      if (task && spent) await db.recordCost(c, task, spent);
      if (!task || task.status !== "RUNNING") return { status: "completed" } as JobOutcome;
      const run = await db.lockRun(c, task.workflow_run_id!);
      const agent = await db.getAgent(c, task.agent_id);
      const def = this.definition(run!);
      const step = getStep(def, task.step_key!);
      await c.query(`select set_config('app.actor_agent_id', $1, true)`, [agent.id]);

      if (shouldRetry(task.retry_count, task.max_retries, retryable)) {
        const delay = backoffMs(task.retry_count);
        await c.query(
          `update public.tasks set status = 'QUEUED', retry_count = retry_count + 1, error = $2, progress = 0,
                  progress_message = $3 where id = $1`,
          [task.id, err.message.slice(0, 2000), `Retrying in ${Math.round(delay / 1000)}s`],
        );
        await db.emitEvent(c, {
          organisationId: task.organisation_id,
          type: "AGENT_FAILED_TASK",
          severity: "WARNING",
          summary: `${agent.display_name} failed "${task.title}"; retry ${task.retry_count + 1} of ${task.max_retries} scheduled`,
          agentId: agent.id,
          tenderId: task.tender_id,
          taskId: task.id,
          runId: task.workflow_run_id,
          correlationId: task.correlation_id,
          payload: { error: err.message, will_retry: true, delay_ms: delay },
        });
        await db.setAgentActivity(c, agent.id, `Failed: ${task.title} (retrying)`, `Retry ${task.title}`);
        await db.refreshAgent(c, agent.id);
        return { status: "retry", runAt: new Date(this.now().getTime() + delay), error: err.message } as JobOutcome;
      }

      await this.failTaskPermanently(c, task, run!, agent, step, err.message);
      return { status: "dead", error: err.message } as JobOutcome;
    });
  }

  /** Marks a task FAILED, blocks the run for human attention, and escalates. One failure never deletes other work. */
  private async failTaskPermanently(c: PoolClient, task: db.TaskRow, run: db.RunRow, agent: db.AgentRow, step: PlanStep, message: string) {
    await c.query(`update public.tasks set status = 'FAILED', failed_at = now(), error = $2 where id = $1`, [task.id, message.slice(0, 2000)]);
    await db.emitEvent(c, {
      organisationId: task.organisation_id,
      type: "AGENT_FAILED_TASK",
      severity: "ERROR",
      summary: `${agent.display_name} failed "${task.title}": ${message}`.slice(0, 500),
      agentId: agent.id,
      tenderId: task.tender_id,
      taskId: task.id,
      runId: run.id,
      correlationId: run.correlation_id,
      payload: { error: message, will_retry: false, retries: task.retry_count },
    });
    if (step.key === "submission") {
      const tender = await db.getTender(c, run.tender_id);
      if (tender.status === "SUBMITTING") {
        await c.query(`select set_config('app.actor_agent_id', $1, true)`, [agent.id]);
        await db.transitionTender(
          c,
          { organisationId: run.organisation_id, tenderId: run.tender_id, agentId: agent.id, runId: run.id, correlationId: run.correlation_id },
          ["SUBMISSION_FAILED"],
          message,
        );
        await db.emitEvent(c, {
          organisationId: run.organisation_id,
          type: "SUBMISSION_FAILED",
          severity: "ERROR",
          summary: `Submission failed: ${message}`.slice(0, 500),
          agentId: agent.id,
          tenderId: run.tender_id,
          taskId: task.id,
          runId: run.id,
          correlationId: run.correlation_id,
        });
      }
    }
    await db.setAgentActivity(c, agent.id, `Failed: ${task.title}`, "Waiting for operator retry");
    await this.blockRun(c, run, `${agent.display_name} failed "${task.title}": ${message}`, agent.id);
    await db.refreshAgent(c, agent.id);
  }

  // -------------------------------------------------------------------------
  private async approvalDecided(approvalId: string): Promise<JobOutcome> {
    await withTx(this.pool, async (c) => {
      const { rows } = await c.query(`select * from public.approvals where id = $1 for update`, [approvalId]);
      const approval = rows[0];
      if (!approval || !approval.workflow_run_id || !approval.task_id) return;
      const run = await db.lockRun(c, approval.workflow_run_id);
      const task = await db.lockTask(c, approval.task_id);
      if (!run || !task || run.status !== "WAITING_APPROVAL" || task.status !== "NEEDS_APPROVAL") return;
      const agent = await db.getAgent(c, task.agent_id);
      const def = this.definition(run);
      await c.query(`select set_config('app.actor_agent_id', $1, true)`, [agent.id]);

      // The handoff into the approval gate is settled by the human decision (or by expiry).
      await c.query(`update public.handoffs set status = $2::public.handoff_status, accepted_at = now() where to_task_id = $1 and status = 'PENDING'`, [
        task.id,
        approval.status === "APPROVED" ? "ACCEPTED" : approval.status === "REJECTED" ? "REJECTED" : "CANCELLED",
      ]);

      if (approval.status === "APPROVED") {
        await c.query(
          `update public.tasks set status = 'COMPLETED', completed_at = now(), progress = 100, blocked_reason = null,
                  progress_message = 'Approved', output = $2 where id = $1`,
          [task.id, JSON.stringify({ approval_status: "APPROVED", approval_id: approval.id, decided_by: approval.decided_by, comments: approval.comments })],
        );
        await c.query(`update public.workflow_runs set status = 'RUNNING' where id = $1`, [run.id]);
        const res = def.resolve("approval", { approval_status: "APPROVED" }, { isSimulation: run.is_simulation });
        if (res.next.type === "step") res.next.payload = { ...res.next.payload, approval_id: approval.id };
        await this.applyResolution(c, { ...run, status: "RUNNING" }, def, res, { task, agent });
      } else if (approval.status === "REJECTED") {
        await c.query(`update public.tasks set status = 'CANCELLED', blocked_reason = 'Approval rejected', output = $2 where id = $1`, [
          task.id,
          JSON.stringify({ approval_status: "REJECTED", comments: approval.comments }),
        ]);
        await db.transitionTender(
          c,
          { organisationId: run.organisation_id, tenderId: run.tender_id, agentId: agent.id, runId: run.id, correlationId: run.correlation_id },
          ["PREPARING_BID"],
          `Approval rejected: ${approval.comments ?? ""}`,
        );
        await c.query(`update public.workflow_runs set status = 'CANCELLED', outcome = 'APPROVAL_REJECTED', error = $2, completed_at = now() where id = $1`, [
          run.id,
          approval.comments,
        ]);
        await db.emitEvent(c, {
          organisationId: run.organisation_id,
          type: "WORKFLOW_CANCELLED",
          severity: "WARNING",
          summary: "Workflow stopped: submission approval rejected",
          tenderId: run.tender_id,
          runId: run.id,
          approvalId: approval.id,
          correlationId: run.correlation_id,
          payload: { comments: approval.comments },
        });
        await this.refreshAgentsInRun(c, run.id);
      } else if (approval.status === "EXPIRED") {
        // The approval expires at the tender's closing time, so the bid can no longer go in.
        await c.query(`update public.tasks set status = 'CANCELLED', blocked_reason = 'Approval expired', output = $2 where id = $1`, [
          task.id,
          JSON.stringify({ approval_status: "EXPIRED" }),
        ]);
        await db.transitionTender(
          c,
          { organisationId: run.organisation_id, tenderId: run.tender_id, agentId: agent.id, runId: run.id, correlationId: run.correlation_id },
          ["CANCELLED"],
          "The closing date passed before the bid was approved",
        );
        await c.query(`update public.workflow_runs set status = 'CANCELLED', outcome = 'APPROVAL_EXPIRED', error = $2, completed_at = now() where id = $1`, [
          run.id,
          "The closing date passed before the bid was approved",
        ]);
        await db.emitEvent(c, {
          organisationId: run.organisation_id,
          type: "WORKFLOW_CANCELLED",
          severity: "WARNING",
          summary: "Workflow stopped: the closing date passed before approval",
          tenderId: run.tender_id,
          runId: run.id,
          approvalId: approval.id,
          correlationId: run.correlation_id,
        });
        await db.notifyMembers(
          c,
          run.organisation_id,
          "APPROVAL_EXPIRED",
          "WARNING",
          "Bid approval expired",
          "The closing date passed before anyone approved the bid, so the run was stopped.",
          `/tenders/${run.tender_id}`,
        );
        await this.refreshAgentsInRun(c, run.id);
      }
      await db.refreshAgent(c, agent.id);
    });
    return { status: "completed" };
  }

  private async refreshRunAgents(runId: string): Promise<JobOutcome> {
    await withTx(this.pool, (c) => this.refreshAgentsInRun(c, runId));
    return { status: "completed" };
  }

  private async refreshAgentsInRun(c: PoolClient, runId: string) {
    const { rows } = await c.query<{ agent_id: string }>(`select distinct agent_id from public.tasks where workflow_run_id = $1`, [runId]);
    for (const r of rows) await db.refreshAgent(c, r.agent_id);
  }
}
