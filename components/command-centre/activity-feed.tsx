"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowRightLeft, CheckCircle2, CircleAlert, Hand, Info, Play, XCircle } from "lucide-react";
import { useLiveRows, useNow } from "@/features/realtime/hooks";
import { formatTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database";

export type EventRow = Database["public"]["Tables"]["agent_events"]["Row"];

function iconFor(e: EventRow) {
  if (e.severity === "ERROR" || e.severity === "CRITICAL") return { Icon: XCircle, cls: "text-red-400" };
  if (e.event_type.startsWith("HANDOFF")) return { Icon: ArrowRightLeft, cls: "text-sky-400" };
  if (e.event_type.startsWith("APPROVAL")) return { Icon: Hand, cls: "text-violet-300" };
  if (e.event_type === "AGENT_STARTED_TASK" || e.event_type === "WORKFLOW_STARTED") return { Icon: Play, cls: "text-cyan-300" };
  if (e.event_type.endsWith("COMPLETED") || e.event_type.endsWith("PASS") || e.event_type === "TENDER_QUALIFIED")
    return { Icon: CheckCircle2, cls: "text-emerald-400" };
  if (e.severity === "WARNING") return { Icon: AlertTriangle, cls: "text-amber-400" };
  if (e.event_type.endsWith("FAIL")) return { Icon: CircleAlert, cls: "text-red-400" };
  return { Icon: Info, cls: "text-muted-foreground" };
}

export interface ActivityFeedProps {
  initial: EventRow[];
  agentNames: Record<string, string>;
  tenderTitles?: Record<string, string>;
  filter?: { tenderId?: string; agentId?: string; runId?: string };
  limit?: number;
  compact?: boolean;
  className?: string;
  /** Append new events as they arrive. Off for historical pages. */
  live?: boolean;
}

/** Live, append-only event stream. Each row is a persisted agent_events record. */
export function ActivityFeed({ initial, agentNames, tenderTitles = {}, filter, limit = 50, compact, className, live = true }: ActivityFeedProps) {
  const now = useNow(20_000);
  const events = useLiveRows<EventRow>("agent_events", initial, {
    filter: (e) =>
      live &&
      (!filter?.tenderId || e.tender_id === filter.tenderId) &&
      (!filter?.agentId || e.agent_id === filter.agentId) &&
      (!filter?.runId || e.workflow_run_id === filter.runId),
    sort: (a, b) => b.created_at.localeCompare(a.created_at),
    limit,
  });

  if (events.length === 0) {
    return <p className={cn("px-1 py-6 text-center text-sm text-muted-foreground", className)}>No activity yet. Events appear here as agents work.</p>;
  }

  return (
    <ol className={cn("grid", className)} aria-live="polite" aria-relevant="additions">
      <AnimatePresence initial={false}>
        {events.map((e) => {
          const { Icon, cls } = iconFor(e);
          return (
            <motion.li
              key={e.id}
              layout="position"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
              className="flex gap-2.5 border-b border-border/60 py-2 last:border-b-0"
            >
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", cls)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13px] leading-snug", compact && "truncate")}>{e.summary}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="font-mono">{e.event_type}</span>
                  {e.agent_id && agentNames[e.agent_id] && (
                    <Link href={`/agents/${e.agent_id}`} className="hover:text-foreground">
                      {agentNames[e.agent_id]}
                    </Link>
                  )}
                  {!filter?.tenderId && e.tender_id && tenderTitles[e.tender_id] && (
                    <Link href={`/tenders/${e.tender_id}`} className="max-w-48 truncate hover:text-foreground">
                      {tenderTitles[e.tender_id]}
                    </Link>
                  )}
                  <time dateTime={e.created_at} title={formatTime(e.created_at)}>
                    {relativeTime(e.created_at, now)}
                  </time>
                </p>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
