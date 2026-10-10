import "server-only";

import { getServerSupabase } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

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
  const agentRows = agents.data ?? [];
  const currentTaskIds = agentRows.map((a) => a.current_task_id).filter(Boolean) as string[];
  const missing = currentTaskIds.filter((id) => !(activeTasks.data ?? []).some((t) => t.id === id));
  const extra = missing.length ? ((await supabase.from("tasks").select(TASK_SUMMARY_COLS).in("id", missing)).data ?? []) : [];
  const tasks = [...(activeTasks.data ?? []), ...extra];

  const tenderIds = [...new Set([...tasks.map((t) => t.tender_id), ...agentRows.map((a) => a.current_tender_id)].filter(Boolean))] as string[];
  const tenders = tenderIds.length ? ((await supabase.from("tenders").select(TENDER_SUMMARY_COLS).in("id", tenderIds)).data ?? []) : [];

  return { departments: deps.data ?? [], agents: agentRows, tasks: tasks as TaskSummary[], tenders: tenders as TenderSummary[] };
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
  const { data } = await q;
  return data ?? [];
}

export async function getRecentHandoffs(orgId: string, limit = 30) {
  const supabase = await getServerSupabase();
  const { data } = await supabase.from("handoffs").select("*").eq("organisation_id", orgId).order("created_at", { ascending: false }).limit(limit);
  return data ?? [];
}

export async function getPendingApprovals(orgId: string) {
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("approvals")
    .select("*, tenders(id,title,reference_number,closing_at)")
    .eq("organisation_id", orgId)
    .eq("status", "PENDING")
    .order("requested_at", { ascending: true });
  return data ?? [];
}

export async function getApprovalHistory(orgId: string, limit = 30) {
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("approvals")
    .select("*, tenders(id,title,reference_number)")
    .eq("organisation_id", orgId)
    .neq("status", "PENDING")
    .order("requested_at", { ascending: false })
    .limit(limit);
  return data ?? [];
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

  const [tenders, agents, costToday, costMonth, upcoming, runs] = await Promise.all([
    supabase.from("tenders").select("status").eq("organisation_id", orgId),
    supabase.from("agents").select("status").eq("organisation_id", orgId),
    supabase.from("cost_usage").select("cost_usd").eq("organisation_id", orgId).gte("created_at", dayStart.toISOString()),
    supabase.from("cost_usage").select("cost_usd").eq("organisation_id", orgId).gte("created_at", monthStart.toISOString()),
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

  const count = <S extends string>(rows: { status: S }[] | null, statuses: S[]) => (rows ?? []).filter((r) => statuses.includes(r.status)).length;
  const t = tenders.data ?? [];
  const a = agents.data ?? [];
  const sum = (rows: { cost_usd: number }[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.cost_usd), 0);

  return {
    tenders: {
      active: count(t, [
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
      new: count(t, ["DISCOVERED"]),
      qualified: count(t, [
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
      preparing: count(t, ["COMPLIANCE_REVIEW", "MISSING_INFORMATION", "PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED"]),
      awaitingApproval: count(t, ["READY_FOR_APPROVAL"]),
      submitted: count(t, ["SUBMITTED", "UNDER_EVALUATION", "CLARIFICATION"]),
      won: count(t, ["AWARDED"]),
      lost: count(t, ["UNSUCCESSFUL"]),
      total: t.length,
    },
    agents: {
      active: count(a, ["RUNNING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]),
      idle: count(a, ["IDLE", "COMPLETED"]),
      failed: count(a, ["FAILED"]),
      blocked: count(a, ["BLOCKED", "PAUSED", "DISABLED"]),
      total: a.length,
    },
    spend: { today: sum(costToday.data), month: sum(costMonth.data) },
    upcoming: (upcoming.data ?? []) as TenderSummary[],
    runs: runs.data ?? [],
    dayStart: dayStart.toISOString(),
  };
}

export async function getWorkerHealth() {
  const supabase = await getServerSupabase();
  const { data } = await supabase.rpc("worker_health");
  const row = data?.[0];
  return { online: (row?.workers ?? 0) > 0, workers: row?.workers ?? 0, lastSeen: row?.last_seen_at ?? null };
}

export async function getUnreadNotifications(userId: string) {
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .is("read_at", null)
    .order("created_at", { ascending: false })
    .limit(20);
  return data ?? [];
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
  return { problemTasks: (failed.data ?? []) as TaskSummary[], blockedRuns: blockedRuns.data ?? [] };
}

/** Titles for tenders referenced in a list of events (for feed links). */
export async function getTenderTitles(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter(Boolean))] as string[];
  if (!unique.length) return {} as Record<string, string>;
  const supabase = await getServerSupabase();
  const { data } = await supabase.from("tenders").select("id,title").in("id", unique);
  return Object.fromEntries((data ?? []).map((t) => [t.id, t.title])) as Record<string, string>;
}
