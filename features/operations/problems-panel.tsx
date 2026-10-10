"use client";

import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { TaskStatusBadge } from "@/components/command-centre/status-badge";
import { Button } from "@/components/ui/button";
import { useLiveRows } from "@/features/realtime/hooks";
import { retryTask } from "@/features/tenders/actions";
import { relativeTime } from "@/lib/format";
import type { TaskLite } from "@/features/office/use-floor-state";

/** Failed, blocked and waiting tasks: the things that need a human. */
export function ProblemsPanel({ initial, agentNames, canRetry }: { initial: TaskLite[]; agentNames: Record<string, string>; canRetry: boolean }) {
  const rows = useLiveRows<TaskLite>("tasks", initial, {
    filter: (t) => t.status === "FAILED" || t.status === "BLOCKED" || t.status === "WAITING",
    sort: (a, b) => b.created_at.localeCompare(a.created_at),
    limit: 20,
  });
  const [pending, start] = useTransition();
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing is failed, blocked or waiting.</p>;
  return (
    <ul className="grid gap-2">
      {rows.map((t) => (
        <li key={t.id} className="rounded-lg border p-2.5">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm">{t.title}</p>
            <TaskStatusBadge status={t.status} />
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {agentNames[t.agent_id] ?? "Agent"} · {relativeTime(t.created_at)}
            {t.tender_id && (
              <>
                {" · "}
                <Link className="hover:text-foreground" href={`/tenders/${t.tender_id}`}>
                  tender
                </Link>
              </>
            )}
          </p>
          {(t.error || t.blocked_reason) && <p className="mt-1 line-clamp-3 text-[11px] text-red-300">{t.error ?? t.blocked_reason}</p>}
          {canRetry && t.status === "FAILED" && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await retryTask(t.id);
                  if (r.ok) toast.success("Retry queued");
                  else toast.error(r.error);
                })
              }
            >
              <RotateCcw /> Retry
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
