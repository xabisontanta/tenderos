"use client";

import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { memo, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Hand, Inbox, X } from "lucide-react";
import { AgentAvatar } from "@/components/command-centre/agent-avatar";
import { AgentStatusBadge } from "@/components/command-centre/status-badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useLiveRows, useNow, useTableChanges } from "@/features/realtime/hooks";
import { useFloorState, type AgentRow, type FloorData, type TaskLite, type TenderLite } from "@/features/office/use-floor-state";
import { SIMULATED_BID_PLAN } from "@/workflows/definitions/plan";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database";

type Approval = Database["public"]["Tables"]["approvals"]["Row"];

interface AgentNodeData extends Record<string, unknown> {
  agent: AgentRow;
  accent: string;
  task?: TaskLite;
  tender?: TenderLite;
  hot: boolean;
}
interface GateNodeData extends Record<string, unknown> {
  label: string;
  pending: number;
  kind: "intake" | "approval";
}

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<Node<AgentNodeData>>) {
  const { agent, accent, task, tender, hot } = data;
  return (
    <div
      className={cn(
        "w-56 rounded-lg border bg-card p-2.5 shadow-lg transition-shadow",
        selected && "border-primary",
        hot && "shadow-[0_0_0_2px] shadow-primary/50",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground/60" />
      <div className="flex items-center gap-2">
        <AgentAvatar slug={agent.slug} accent={accent} size="sm" active={agent.status === "RUNNING"} />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{agent.display_name}</p>
          <AgentStatusBadge status={agent.status} className="mt-0.5" />
        </div>
      </div>
      {task && agent.status !== "IDLE" && (
        <div className="mt-2">
          <p className="truncate text-[11px]">{task.title}</p>
          {tender && <p className="truncate text-[10px] text-muted-foreground">{tender.title}</p>}
          {agent.status === "RUNNING" && <Progress value={task.progress} className="mt-1.5 h-1" />}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground/60" />
    </div>
  );
});

const GateNode = memo(function GateNode({ data }: NodeProps<Node<GateNodeData>>) {
  const Icon = data.kind === "approval" ? Hand : Inbox;
  return (
    <div
      className={cn(
        "w-40 rounded-lg border border-dashed bg-card/70 p-2.5 text-center",
        data.kind === "approval" && data.pending > 0 && "border-violet-500/60 bg-violet-500/10",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground/60" />
      <Icon className={cn("mx-auto size-4", data.kind === "approval" ? "text-violet-300" : "text-muted-foreground")} aria-hidden />
      <p className="mt-1 text-xs font-medium">{data.label}</p>
      {data.kind === "approval" && <p className="text-[10px] text-muted-foreground">{data.pending ? `${data.pending} pending` : "None pending"}</p>}
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground/60" />
    </div>
  );
});

const nodeTypes = { agent: AgentNode, gate: GateNode };
const HOT_MS = 6000;

/** Node graph of the bid pipeline. Node state and edge activity come from persisted rows and events. */
export function WorkflowGraph({ initial, approvals: initialApprovals }: { initial: FloorData; approvals: Approval[] }) {
  const { agents, taskById, tenderById } = useFloorState(initial);
  const approvals = useLiveRows<Approval>("approvals", initialApprovals, { filter: (a) => a.status === "PENDING" });
  const now = useNow(2000);
  const [recent, setRecent] = useState<Array<{ from: string | null; to: string; approval: boolean; at: number }>>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useTableChanges("handoffs", (p) => {
    if (p.eventType !== "INSERT") return;
    const h = p.new as { from_agent_id: string | null; to_agent_id: string; to_approval: boolean };
    setRecent((r) => [...r.filter((x) => Date.now() - x.at < HOT_MS), { from: h.from_agent_id, to: h.to_agent_id, approval: h.to_approval, at: Date.now() }]);
  });

  const depAccent = useMemo(() => new Map(initial.departments.map((d) => [d.id, d.accent])), [initial.departments]);
  const bySlug = useMemo(() => new Map(agents.map((a) => [a.slug, a])), [agents]);

  const { nodes, edges } = useMemo(() => {
    const hot = recent.filter((r) => now.getTime() - r.at < HOT_MS);
    // Pipeline wraps onto two rows of PER_ROW so the graph stays legible at fit-view zoom.
    const PER_ROW = 5;
    const at = (slot: number, gate = false) => ({ x: (slot % PER_ROW) * 270, y: Math.floor(slot / PER_ROW) * 190 + (gate ? 30 : 0) });
    const nodes: Node[] = [{ id: "intake", type: "gate", position: at(0, true), data: { label: "New tender", pending: 0, kind: "intake" } }];
    const edges: Edge[] = [];
    let prevId = "intake";
    const pipelineSlugs = new Set<string>();

    SIMULATED_BID_PLAN.forEach((step, i) => {
      const slot = i + 1;
      if (step.kind === "approval") {
        const id = "approval";
        nodes.push({ id, type: "gate", position: at(slot, true), data: { label: "Human approval", pending: approvals.length, kind: "approval" } });
        edges.push(
          edge(
            prevId,
            id,
            hot.some((h) => h.approval),
            approvals.length > 0,
          ),
        );
        prevId = id;
        return;
      }
      const agent = bySlug.get(step.agent);
      if (!agent) return;
      pipelineSlugs.add(step.agent);
      const id = agent.id;
      if (!nodes.some((n) => n.id === id)) {
        nodes.push({
          id,
          type: "agent",
          position: at(slot),
          data: {
            agent,
            accent: depAccent.get(agent.department_id) ?? "slate",
            task: agent.current_task_id ? taskById.get(agent.current_task_id) : undefined,
            tender: agent.current_tender_id ? tenderById.get(agent.current_tender_id) : undefined,
            hot: hot.some((h) => h.to === id),
          } satisfies AgentNodeData,
        });
      }
      edges.push(
        edge(
          prevId,
          id,
          hot.some((h) => h.to === id && !h.approval),
          agent.status === "RUNNING",
        ),
      );
      prevId = id;
    });

    // Supporting agents not yet in the pipeline sit on a lower row.
    agents
      .filter((a) => !pipelineSlugs.has(a.slug))
      .forEach((agent, i) => {
        nodes.push({
          id: agent.id,
          type: "agent",
          position: { x: (i % 6) * 225, y: 420 + Math.floor(i / 6) * 120 },
          data: { agent, accent: depAccent.get(agent.department_id) ?? "slate", hot: false } satisfies AgentNodeData,
        });
      });
    return { nodes, edges };
  }, [agents, approvals.length, bySlug, depAccent, now, recent, taskById, tenderById]);

  const sel = selected ? agents.find((a) => a.id === selected) : undefined;
  const selTask = sel?.current_task_id ? taskById.get(sel.current_task_id) : undefined;

  return (
    <div className="relative h-[560px] overflow-hidden rounded-xl border bg-card/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, n) => setSelected(n.type === "agent" ? n.id : null)}
        onPaneClick={() => setSelected(null)}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        aria-label="Agent workflow graph"
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {sel && (
        <aside className="absolute right-3 top-3 z-10 w-72 rounded-lg border bg-popover p-3 shadow-2xl" aria-label={`${sel.display_name} details`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{sel.display_name}</p>
              <p className="text-[11px] text-muted-foreground">{sel.role_title}</p>
            </div>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setSelected(null)} aria-label="Close panel">
              <X />
            </Button>
          </div>
          <div className="mt-2">
            <AgentStatusBadge status={sel.status} />
          </div>
          <dl className="mt-3 grid gap-1.5 text-[11px]">
            <Row k="Current task" v={selTask?.title ?? "—"} />
            <Row k="Progress" v={selTask ? `${selTask.progress}% · ${selTask.progress_message ?? ""}` : "—"} />
            <Row k="Last action" v={sel.last_action ? `${sel.last_action} (${relativeTime(sel.last_action_at, now)})` : "—"} />
            <Row k="Next" v={sel.next_expected_action ?? "—"} />
            {sel.status_reason && <Row k="Reason" v={sel.status_reason} />}
          </dl>
          <Button asChild size="sm" variant="outline" className="mt-3 w-full">
            <Link href={`/agents/${sel.id}`}>Open agent</Link>
          </Button>
        </aside>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[84px_1fr] gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="break-words">{v}</dd>
    </div>
  );
}

function edge(source: string, target: string, active: boolean, live: boolean): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: "smoothstep",
    animated: active,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: active ? "oklch(0.8 0.12 210)" : "oklch(0.45 0.02 260)" },
    style: { stroke: active ? "oklch(0.8 0.12 210)" : live ? "oklch(0.6 0.06 220)" : "oklch(0.4 0.015 260)", strokeWidth: active ? 2.5 : 1.5 },
  };
}
