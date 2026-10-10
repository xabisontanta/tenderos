import Link from "next/link";
import { Check, Circle, Hand, Loader2, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { TaskStatusBadge } from "@/components/command-centre/status-badge";
import { SIMULATED_BID_PLAN } from "@/workflows/definitions/plan";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskSummary } from "@/lib/data/queries";

function duration(a: string | null, b: string | null) {
  if (!a || !b) return null;
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Visual progress through the workflow, built from the run's persisted tasks. */
export function WorkflowTimeline({ tasks, agentNames }: { tasks: TaskSummary[]; agentNames: Record<string, string> }) {
  const byStep = new Map(tasks.map((t) => [t.step_key, t]));
  return (
    <ol className="relative grid gap-0">
      {SIMULATED_BID_PLAN.map((step, i) => {
        const t = byStep.get(step.key);
        const state = t?.status;
        const Icon = state === "COMPLETED" ? Check : state === "RUNNING" ? Loader2 : state === "FAILED" ? X : state === "NEEDS_APPROVAL" ? Hand : Circle;
        return (
          <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
            {i < SIMULATED_BID_PLAN.length - 1 && (
              <span
                aria-hidden
                className={cn("absolute left-[11px] top-6 h-[calc(100%-12px)] w-px", state === "COMPLETED" ? "bg-emerald-500/50" : "bg-border")}
              />
            )}
            <span
              className={cn(
                "relative z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card",
                state === "COMPLETED" && "border-emerald-500/60 text-emerald-400",
                state === "RUNNING" && "border-sky-400/70 text-sky-300",
                state === "FAILED" && "border-red-500/60 text-red-400",
                state === "NEEDS_APPROVAL" && "border-violet-400/70 text-violet-300",
                !state && "text-muted-foreground",
              )}
            >
              <Icon className={cn("size-3.5", state === "RUNNING" && "animate-spin motion-reduce:animate-none")} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={cn("text-sm", !t && "text-muted-foreground")}>{step.title}</p>
                {t && <TaskStatusBadge status={t.status} />}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t ? (
                  <>
                    <Link href={`/agents/${t.agent_id}`} className="hover:text-foreground">
                      {agentNames[t.agent_id] ?? step.agent}
                    </Link>
                    {t.started_at && ` · started ${formatTime(t.started_at)}`}
                    {duration(t.started_at, t.completed_at) && ` · took ${duration(t.started_at, t.completed_at)}`}
                  </>
                ) : (
                  "Not started"
                )}
              </p>
              {t?.status === "RUNNING" && (
                <div className="mt-1.5 max-w-sm">
                  <Progress value={t.progress} />
                  <p className="mt-1 text-[11px] text-cyan-300/90">{t.progress_message}</p>
                </div>
              )}
              {t?.error && <p className="mt-1 text-[11px] text-red-300">{t.error}</p>}
              {t?.blocked_reason && t.status !== "COMPLETED" && <p className="mt-1 text-[11px] text-amber-300">{t.blocked_reason}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
