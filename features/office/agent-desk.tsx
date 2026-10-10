"use client";

import Link from "next/link";
import { forwardRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AgentAvatar, accentFor } from "@/components/command-centre/agent-avatar";
import { AgentStatusBadge } from "@/components/command-centre/status-badge";
import { Progress } from "@/components/ui/progress";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentRow, TaskLite, TenderLite } from "./use-floor-state";

interface Props {
  agent: AgentRow;
  accent: string;
  task: TaskLite | undefined;
  tender: TenderLite | undefined;
  now: Date;
  highlighted: boolean;
}

/** One agent at their desk. Every field shown is a persisted column. */
export const AgentDesk = forwardRef<HTMLDivElement, Props>(function AgentDesk({ agent, accent, task, tender, now, highlighted }, ref) {
  const a = accentFor(accent);
  const running = agent.status === "RUNNING";
  const attention = agent.status === "NEEDS_APPROVAL" || agent.status === "FAILED" || agent.status === "BLOCKED";

  return (
    <div
      ref={ref}
      data-agent-id={agent.id}
      className={cn(
        "relative rounded-lg border bg-background/50 p-3 transition-[border-color,box-shadow] duration-500",
        running && a.border,
        highlighted && "border-primary/70 shadow-[0_0_0_1px] shadow-primary/40",
      )}
    >
      {attention && <span className="absolute right-2 top-2 size-2 rounded-full bg-violet-400" aria-label="Needs attention" />}
      <Link href={`/agents/${agent.id}`} className="flex items-start gap-2.5 rounded-sm">
        <AgentAvatar slug={agent.slug} accent={accent} active={running} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{agent.display_name}</p>
          <p className="truncate text-[11px] text-muted-foreground">{agent.role_title}</p>
        </div>
      </Link>
      <div className="mt-2">
        <AgentStatusBadge status={agent.status} />
      </div>

      <AnimatePresence>
        {task &&
          (agent.status === "RUNNING" ||
            agent.status === "QUEUED" ||
            agent.status === "WAITING" ||
            agent.status === "NEEDS_APPROVAL" ||
            agent.status === "BLOCKED") && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="mt-2.5 rounded-md border border-border/70 bg-card/60 p-2">
                <p className="truncate text-xs font-medium">{task.title}</p>
                {tender && (
                  <Link href={`/tenders/${tender.id}`} className="block truncate text-[11px] text-muted-foreground hover:text-foreground">
                    {tender.reference_number ? `${tender.reference_number} · ` : ""}
                    {tender.title}
                  </Link>
                )}
                {agent.status === "RUNNING" && (
                  <>
                    <Progress value={task.progress} className="mt-2" aria-label={`${task.title} progress`} />
                    <p className="mt-1 truncate text-[11px] text-cyan-300/90">{task.progress_message ?? "Working"}</p>
                  </>
                )}
                {(agent.status === "WAITING" || agent.status === "BLOCKED") && task.blocked_reason && (
                  <p className="mt-1 text-[11px] text-amber-300">{task.blocked_reason}</p>
                )}
              </div>
            </motion.div>
          )}
      </AnimatePresence>

      <dl className="mt-2.5 grid grid-cols-1 gap-1 text-[11px]">
        <div className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-muted-foreground">Last:</dt>
          <dd className="min-w-0 truncate" title={agent.last_action ?? undefined}>
            {agent.last_action ?? "No activity yet"}
            {agent.last_action_at && <span className="text-muted-foreground"> · {relativeTime(agent.last_action_at, now)}</span>}
          </dd>
        </div>
        {agent.next_expected_action && (
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted-foreground">Next:</dt>
            <dd className="min-w-0 truncate">{agent.next_expected_action}</dd>
          </div>
        )}
      </dl>
    </div>
  );
});
