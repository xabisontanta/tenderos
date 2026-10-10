"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { JsonView } from "@/components/command-centre/json-view";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLiveRows } from "@/features/realtime/hooks";
import { formatDateTime, humanize, relativeTime } from "@/lib/format";
import type { Database } from "@/types/database";

type Handoff = Database["public"]["Tables"]["handoffs"]["Row"];

/** Structured handoffs between agents; click one to inspect its payload. */
export function HandoffList({
  initial,
  agentNames,
  tenderTitles = {},
  tenderId,
  limit = 20,
}: {
  initial: Handoff[];
  agentNames: Record<string, string>;
  tenderTitles?: Record<string, string>;
  tenderId?: string;
  limit?: number;
}) {
  const rows = useLiveRows<Handoff>("handoffs", initial, {
    filter: (h) => !tenderId || h.tender_id === tenderId,
    sort: (a, b) => b.created_at.localeCompare(a.created_at),
    limit,
  });
  const [open, setOpen] = useState<Handoff | null>(null);
  const name = (id: string | null, approval = false) => (approval ? "Human approval" : id ? (agentNames[id] ?? "Agent") : "System");

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No handoffs yet.</p>;
  return (
    <>
      <ul className="grid grid-cols-1 gap-1.5">
        {rows.map((h) => (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => setOpen(h)}
              className="w-full rounded-lg border p-2 text-left hover:border-primary/40 focus-visible:border-primary"
              aria-label={`Inspect handoff ${humanize(h.handoff_type)}`}
            >
              <div className="flex items-center gap-1.5 text-[12px]">
                <span className="truncate">{h.from_approval ? "Human approval" : name(h.from_agent_id)}</span>
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{name(h.to_agent_id, h.to_approval)}</span>
                <Badge variant={h.status === "ACCEPTED" ? "success" : h.status === "PENDING" ? "info" : "outline"} className="ml-auto">
                  {humanize(h.status)}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                <span className="font-mono">{h.handoff_type}</span>
                {!tenderId && h.tender_id && tenderTitles[h.tender_id] && ` · ${tenderTitles[h.tender_id]}`} · {relativeTime(h.created_at)}
              </p>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {open.from_approval ? "Human approval" : name(open.from_agent_id)} → {name(open.to_agent_id, open.to_approval)}
                </DialogTitle>
                <DialogDescription>
                  {open.handoff_type} · created {formatDateTime(open.created_at)}
                  {open.accepted_at && ` · accepted ${formatDateTime(open.accepted_at)}`}
                </DialogDescription>
              </DialogHeader>
              <JsonView
                value={{
                  handoff_id: open.id,
                  from_agent: open.from_agent_id,
                  to_agent: open.to_agent_id,
                  to_approval: open.to_approval,
                  tender_id: open.tender_id,
                  from_task_id: open.from_task_id,
                  to_task_id: open.to_task_id,
                  handoff_type: open.handoff_type,
                  status: open.status,
                  correlation_id: open.correlation_id,
                  payload: open.payload,
                }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
