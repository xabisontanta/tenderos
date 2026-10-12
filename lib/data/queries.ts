import "server-only";

import { getServerSupabase } from "@/lib/supabase/server";
import type { Database } from "@/types/database";
import type { TenderStatus } from "@/lib/domain/tender-state";

type T = Database["public"]["Tables"];
export type AgentRow = T["agents"]["Row"];
export type DepartmentRow = T["departments"]["Row"];
export type TaskRow = T["tasks"]["Row"];
export type TenderRow = T["tenders"]["Row"];
export type EventRow = T["agent_events"]["Row"];
export type HandoffRow = T["handoffs"]["Row"];
export type ApprovalRow = T["approvals"]["Row"];
export type RunRow = T["workflow_runs"]["Row"];

export type TaskSummary = Pick<
  TaskRow,
  | "id"
  | "title"
  | "status"
  | "progress"
  | "progress_message"
  | "tender_id"
  | "agent_id"
  | "step_key"
  | "workflow_run_id"
  | "created_at"
  | "started_at"
  | "completed_at"
  | "error"
  | "blocked_reason"
>;
export type TenderSummary = Pick<TenderRow, "id" | "title" | "reference_number" | "status" | "closing_at" | "is_simulation" | "issuing_organisation">;

const TASK_SUMMARY_COLS =
  "id,title,status,progress,progress_message,tender_id,agent_id,step_key,workflow_run_id,created_at,started_at,completed_at,error,blocked_reason";
const TENDER_SUMMARY_COLS = "id,title,reference_number,status,closing_at,is_simulation,issuing_organisation";
const ACTIVE_TASK_STATUSES = ["QUEUED", "RUNNING", "WAITING", "BLOCKED", "NEEDS_APPROVAL"] as const;

/**
 * The rows of a query, or an error naming what could not be loaded. A failed query must never look like an empty
 * list: a screen that quietly shows "nothing here" when the database refused is worse than one that says so.
 */
export function rowsOrThrow<T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  return res.data ?? [];
}

/** The single row of a `maybeSingle()` query (null when there is none), or an error naming what could not be loaded. */
export function rowOrThrow<T>(res: { data: T | null; error: { message: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  return res.data;
}

/** Departments, agents, their current tasks and the tenders those tasks belong to. */
export async function getAgentFloor(orgId: string) {
  const supabase = await getServerSupabase();
  const [deps, agents, activeTasks] = await Promise.all([
    supabase.from("departments").select("*").eq("organisation_id", orgId).order("sort_order"),
    supabase.from("agents").select("*").eq("organisation_id", orgId).order("display_name"),
    supabase
      .from("tasks")
      .select(TASK_SUMMARY_COLS)
      .eq("organisation_id", orgId)
      .in("status", [...ACTIVE_TASK_STATUSES])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  const departments = rowsOrThrow(deps, "departments");
  const agentRows = rowsOrThrow(agents, "agents");
  const active = rowsOrThrow(activeTasks, "tasks");
  const currentTaskIds = agentRows.map((a) => a.current_task_id).filter(Boolean) as string[];
  const missing = currentTaskIds.filter((id) => !active.some((t) => t.id === id));
  const extra = missing.length ? rowsOrThrow(await supabase.from("tasks").select(TASK_SUMMARY_COLS).in("id", missing), "tasks") : [];
  const tasks = [...active, ...extra];

  const tenderIds = [...new Set([...tasks.map((t) => t.tender_id), ...agentRows.map((a) => a.current_tender_id)].filter(Boolean))] as string[];
  const tenders = tenderIds.length ? rowsOrThrow(await supabase.from("tenders").select(TENDER_SUMMARY_COLS).in("id", tenderIds), "tenders") : [];

  return { departments, agents: agentRows, tasks: tasks as TaskSummary[], tenders: tenders as TenderSummary[] };
}

export async function getRecentEvents(orgId: string, opts: { limit?: number; before?: string; tenderId?: string; agentId?: string; runId?: string } = {}) {
  const supabase = await getServerSupabase();
  let q = supabase
    .from("agent_events")
    .select("*")
    .eq("organisation_id", orgId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.before) q = q.lt("created_at", opts.before);
  if (opts.tenderId) q = q.eq("tender_id", opts.tenderId);
  if (opts.agentId) q = q.eq("agent_id", opts.agentId);
  if (opts.runId) q = q.eq("workflow_run_id", opts.runId);
  return rowsOrThrow(await q, "events");
}

export async function getRecentHandoffs(orgId: string, limit = 30) {
  const supabase = await getServerSupabase();
  return rowsOrThrow(
    await supabase.from("handoffs").select("*").eq("organisation_id", orgId).order("created_at", { ascending: false }).limit(limit),
    "handoffs",
  );
}

export async function getPendingApprovals(orgId: string) {
  const supabase = await getServerSupabase();
  return rowsOrThrow(
    await supabase
      .from("approvals")
      .select("*, tenders(id,title,reference_number,closing_at)")
      .eq("organisation_id", orgId)
      .eq("status", "PENDING")
      .order("requested_at", { ascending: true }),
    "approvals",
  );
}

export async function getApprovalHistory(orgId: string, limit = 30) {
  const supabase = await getServerSupabase();
  return rowsOrThrow(
    await supabase
      .from("approvals")
      .select("*, tenders(id,title,reference_number)")
      .eq("organisation_id", orgId)
      .neq("status", "PENDING")
      .order("requested_at", { ascending: false })
      .limit(limit),
    "approval history",
  );
}

export async function getDashboardData(orgId: string) {
  const supabase = await getServerSupabase();
  const now = new Date();
  // South Africa is UTC+2 year-round (no daylight saving).
  const SA_OFFSET = 2 * 3_600_000;
  const saNow = new Date(now.getTime() + SA_OFFSET);
  const dayStart = new Date(Date.UTC(saNow.getUTCFullYear(), saNow.getUTCMonth(), saNow.getUTCDate()) - SA_OFFSET);
  const monthStart = new Date(Date.UTC(saNow.getUTCFullYear(), saNow.getUTCMonth(), 1) - SA_OFFSET);
  const in14 = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  const [counts, agents, upcoming, runs] = await Promise.all([
    supabase.rpc("dashboard_counts", { p_org: orgId, p_day_start: dayStart.toISOString(), p_month_start: monthStart.toISOString() }),
    supabase.from("agents").select("status").eq("organisation_id", orgId),
    supabase
      .from("tenders")
      .select(TENDER_SUMMARY_COLS)
      .eq("organisation_id", orgId)
      .gte("closing_at", now.toISOString())
      .lte("closing_at", in14)
      .not("status", "in", "(REJECTED,CANCELLED,ARCHIVED,SUBMITTED,UNDER_EVALUATION,AWARDED,UNSUCCESSFUL)")
      .order("closing_at")
      .limit(8),
    supabase
      .from("workflow_runs")
      .select("id,status,current_step,tender_id,is_simulation,created_at,error,tenders(title)")
      .eq("organisation_id", orgId)
      .in("status", ["PENDING", "RUNNING", "WAITING_APPROVAL", "BLOCKED"])
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  if (counts.error) throw new Error(`Could not load the dashboard counts: ${counts.error.message}`);
  const totals = counts.data as { tenders: Record<string, number>; cost_today: number; cost_month: number };
  const byStatus = totals.tenders ?? {};
  const tally = (statuses: TenderStatus[]) => statuses.reduce((n, s) => n + Number(byStatus[s] ?? 0), 0);
  const count = <S extends string>(rows: { status: S }[] | null, statuses: S[]) => (rows ?? []).filter((r) => statuses.includes(r.status)).length;
  const a = rowsOrThrow(agents, "agents");
  const upcomingRows = rowsOrThrow(upcoming, "upcoming tenders");
  const runRows = rowsOrThrow(runs, "workflow runs");

  return {
    tenders: {
      /** Tenders per status, counted by the database (one query, not a row per tender). */
      byStatus,
      active: tally([
        "INGESTING",
        "ANALYSING",
        "QUALIFYING",
        "QUALIFIED",
        "COMPLIANCE_REVIEW",
        "MISSING_INFORMATION",
        "PREPARING_BID",
        "PRICING",
        "QUALITY_ASSURANCE",
        "QA_FAILED",
        "READY_FOR_APPROVAL",
        "APPROVED",
        "SUBMITTING",
        "SUBMISSION_FAILED",
      ]),
      new: tally(["DISCOVERED"]),
      qualified: tally([
        "QUALIFIED",
        "COMPLIANCE_REVIEW",
        "MISSING_INFORMATION",
        "PREPARING_BID",
        "PRICING",
        "QUALITY_ASSURANCE",
        "QA_FAILED",
        "READY_FOR_APPROVAL",
        "APPROVED",
        "SUBMITTING",
      ]),
      preparing: tally(["COMPLIANCE_REVIEW", "MISSING_INFORMATION", "PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED"]),
      awaitingApproval: tally(["READY_FOR_APPROVAL"]),
      submitted: tally(["SUBMITTED", "UNDER_EVALUATION", "CLARIFICATION"]),
      won: tally(["AWARDED"]),
      lost: tally(["UNSUCCESSFUL"]),
      total: Object.values(byStatus).reduce((n, v) => n + Number(v), 0),
    },
    agents: {
      active: count(a, ["RUNNING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]),
      idle: count(a, ["IDLE", "COMPLETED"]),
      failed: count(a, ["FAILED"]),
      blocked: count(a, ["BLOCKED", "PAUSED", "DISABLED"]),
      total: a.length,
    },
    spend: { today: Number(totals.cost_today ?? 0), month: Number(totals.cost_month ?? 0) },
    upcoming: upcomingRows as TenderSummary[],
    runs: runRows,
    dayStart: dayStart.toISOString(),
  };
}

export async function getWorkerHealth() {
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.rpc("worker_health");
  if (error) throw new Error(`Could not load the worker status: ${error.message}`);
  const row = data?.[0];
  return { online: (row?.workers ?? 0) > 0, workers: row?.workers ?? 0, lastSeen: row?.last_seen_at ?? null };
}

export async function getUnreadNotifications(userId: string) {
  const supabase = await getServerSupabase();
  return rowsOrThrow(
    await supabase.from("notifications").select("*").eq("user_id", userId).is("read_at", null).order("created_at", { ascending: false }).limit(20),
    "notifications",
  );
}

export async function getQueueHealth(orgId: string) {
  const supabase = await getServerSupabase();
  const [failed, blockedRuns] = await Promise.all([
    supabase
      .from("tasks")
      .select(TASK_SUMMARY_COLS)
      .eq("organisation_id", orgId)
      .in("status", ["FAILED", "BLOCKED", "WAITING"])
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("workflow_runs")
      .select("id,tender_id,error,status,current_step,tenders(title)")
      .eq("organisation_id", orgId)
      .eq("status", "BLOCKED")
      .limit(20),
  ]);
  return { problemTasks: rowsOrThrow(failed, "failed tasks") as TaskSummary[], blockedRuns: rowsOrThrow(blockedRuns, "blocked workflows") };
}

/** Titles for tenders referenced in a list of events (for feed links). */
export async function getTenderTitles(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (!unique.length) return {} as Record<string, string>;
  const supabase = await getServerSupabase();
  const data = rowsOrThrow(await supabase.from("tenders").select("id,title").in("id", unique), "tender titles");
  return Object.fromEntries(data.map((t) => [t.id, t.title])) as Record<string, string>;
}
