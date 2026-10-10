import type { Database } from "@/types/database";

export type AgentStatus = Database["public"]["Enums"]["agent_status"];
export type TaskStatus = Database["public"]["Enums"]["task_status"];

/** Statuses set by an operator; the engine never overrides them. */
export const MANUAL_AGENT_STATUSES: readonly AgentStatus[] = ["PAUSED", "DISABLED"];

export interface AgentTaskSnapshot {
  id: string;
  tender_id: string | null;
  status: TaskStatus;
  priority: number;
  created_at: string;
  blocked_reason?: string | null;
  run_active: boolean;
}

export interface DerivedAgentState {
  status: AgentStatus;
  currentTaskId: string | null;
  currentTenderId: string | null;
  reason: string | null;
}

const ACTIVE_ORDER: readonly TaskStatus[] = ["RUNNING", "NEEDS_APPROVAL", "BLOCKED", "WAITING", "QUEUED"];

const TASK_TO_AGENT: Partial<Record<TaskStatus, AgentStatus>> = {
  RUNNING: "RUNNING",
  NEEDS_APPROVAL: "NEEDS_APPROVAL",
  BLOCKED: "BLOCKED",
  WAITING: "WAITING",
  QUEUED: "QUEUED",
};

/**
 * Derives an agent's status from its tasks. Active work wins, in the order
 * RUNNING > NEEDS_APPROVAL > BLOCKED > WAITING > QUEUED. With no active work,
 * the agent shows the outcome of its latest task while that workflow is still
 * in flight (COMPLETED or FAILED), otherwise IDLE. Manual states are sticky.
 */
export function deriveAgentState(current: AgentStatus, tasks: AgentTaskSnapshot[]): DerivedAgentState {
  const byRecency = [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));

  for (const status of ACTIVE_ORDER) {
    const match = byRecency.filter((t) => t.status === status).sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0];
    if (match) {
      const derived = TASK_TO_AGENT[status]!;
      return {
        status: MANUAL_AGENT_STATUSES.includes(current) ? current : derived,
        currentTaskId: match.id,
        currentTenderId: match.tender_id,
        reason: match.blocked_reason ?? null,
      };
    }
  }

  if (MANUAL_AGENT_STATUSES.includes(current)) {
    return { status: current, currentTaskId: null, currentTenderId: null, reason: null };
  }

  const latest = byRecency[0];
  if (latest && latest.run_active && (latest.status === "COMPLETED" || latest.status === "FAILED")) {
    return {
      status: latest.status,
      currentTaskId: latest.id,
      currentTenderId: latest.tender_id,
      reason: latest.status === "FAILED" ? "Latest task failed" : null,
    };
  }
  return { status: "IDLE", currentTaskId: null, currentTenderId: null, reason: null };
}
