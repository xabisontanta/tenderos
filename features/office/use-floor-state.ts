"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { useLiveRows } from "@/features/realtime/hooks";
import type { Database } from "@/types/database";

type T = Database["public"]["Tables"];
export type AgentRow = T["agents"]["Row"];
export type DepartmentRow = T["departments"]["Row"];
export type TaskLite = Pick<
  T["tasks"]["Row"],
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
export type TenderLite = Pick<T["tenders"]["Row"], "id" | "title" | "reference_number" | "status" | "closing_at" | "is_simulation" | "issuing_organisation">;

export interface FloorData {
  departments: DepartmentRow[];
  agents: AgentRow[];
  tasks: TaskLite[];
  tenders: TenderLite[];
}

/**
 * Live model of the agent floor: agents, their current tasks, and tender
 * titles, all kept current from realtime row changes. Unknown tenders are
 * fetched on demand (RLS applies).
 */
export function useFloorState(initial: FloorData) {
  const agents = useLiveRows<AgentRow>("agents", initial.agents);
  const tasks = useLiveRows<TaskLite>("tasks", initial.tasks, { limit: 300 });
  const liveTenders = useLiveRows<TenderLite>("tenders", initial.tenders);
  const [fetched, setFetched] = useState<TenderLite[]>([]);

  const tenderById = useMemo(() => {
    const m = new Map<string, TenderLite>();
    for (const t of [...fetched, ...liveTenders]) m.set(t.id, t);
    return m;
  }, [fetched, liveTenders]);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  useEffect(() => {
    const missing = [...new Set(agents.map((a) => a.current_tender_id).filter((id): id is string => !!id && !tenderById.has(id)))];
    if (!missing.length) return;
    void getBrowserSupabase()
      .from("tenders")
      .select("id,title,reference_number,status,closing_at,is_simulation,issuing_organisation")
      .in("id", missing)
      .then(({ data }) => data && setFetched((prev) => [...prev, ...data]));
  }, [agents, tenderById]);

  return { agents, tasks, taskById, tenderById };
}
