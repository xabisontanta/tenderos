import { AlertOctagon, Ban, CheckCircle2, CircleDashed, CircleDot, Clock, Hand, Hourglass, Loader2, PauseCircle, ShieldAlert, XCircle } from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { humanize } from "@/lib/format";
import type { Database } from "@/types/database";

type Enums = Database["public"]["Enums"];
type Variant = "default" | "secondary" | "outline" | "success" | "warning" | "danger" | "info" | "violet";

interface Style {
  variant: Variant;
  icon: ComponentType<{ className?: string }>;
  spin?: boolean;
}

const AGENT: Record<Enums["agent_status"], Style> = {
  IDLE: { variant: "outline", icon: CircleDashed },
  QUEUED: { variant: "secondary", icon: Clock },
  RUNNING: { variant: "info", icon: Loader2, spin: true },
  WAITING: { variant: "warning", icon: Hourglass },
  BLOCKED: { variant: "danger", icon: ShieldAlert },
  NEEDS_APPROVAL: { variant: "violet", icon: Hand },
  PAUSED: { variant: "warning", icon: PauseCircle },
  COMPLETED: { variant: "success", icon: CheckCircle2 },
  FAILED: { variant: "danger", icon: XCircle },
  DISABLED: { variant: "outline", icon: Ban },
};

const TASK: Record<Enums["task_status"], Style> = {
  QUEUED: AGENT.QUEUED,
  RUNNING: AGENT.RUNNING,
  WAITING: AGENT.WAITING,
  BLOCKED: AGENT.BLOCKED,
  NEEDS_APPROVAL: AGENT.NEEDS_APPROVAL,
  COMPLETED: AGENT.COMPLETED,
  FAILED: AGENT.FAILED,
  CANCELLED: { variant: "outline", icon: Ban },
};

const RUN: Record<Enums["workflow_run_status"], Style> = {
  PENDING: AGENT.QUEUED,
  RUNNING: AGENT.RUNNING,
  WAITING_APPROVAL: AGENT.NEEDS_APPROVAL,
  BLOCKED: AGENT.BLOCKED,
  COMPLETED: AGENT.COMPLETED,
  FAILED: AGENT.FAILED,
  CANCELLED: TASK.CANCELLED,
};

const APPROVAL: Record<Enums["approval_status"], Style> = {
  PENDING: AGENT.NEEDS_APPROVAL,
  APPROVED: AGENT.COMPLETED,
  REJECTED: AGENT.FAILED,
  EXPIRED: { variant: "outline", icon: Clock },
  CANCELLED: TASK.CANCELLED,
};

function tenderStyle(s: Enums["tender_status"]): Style {
  switch (s) {
    case "DISCOVERED":
      return { variant: "secondary", icon: CircleDot };
    case "REJECTED":
    case "QA_FAILED":
    case "SUBMISSION_FAILED":
    case "UNSUCCESSFUL":
      return { variant: "danger", icon: XCircle };
    case "MISSING_INFORMATION":
    case "CLARIFICATION":
      return { variant: "warning", icon: AlertOctagon };
    case "READY_FOR_APPROVAL":
      return { variant: "violet", icon: Hand };
    case "SUBMITTED":
    case "AWARDED":
    case "APPROVED":
    case "QUALIFIED":
      return { variant: "success", icon: CheckCircle2 };
    case "CANCELLED":
    case "ARCHIVED":
      return { variant: "outline", icon: Ban };
    case "UNDER_EVALUATION":
      return { variant: "secondary", icon: Hourglass };
    default:
      return { variant: "info", icon: Loader2 };
  }
}

function Render({ style, label, className }: { style: Style; label: string; className?: string }) {
  const Icon = style.icon;
  return (
    <Badge variant={style.variant} className={className}>
      <Icon className={style.spin ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden />
      {label}
    </Badge>
  );
}

export function AgentStatusBadge({ status, className }: { status: Enums["agent_status"]; className?: string }) {
  return <Render style={AGENT[status]} label={humanize(status)} className={className} />;
}
export function TaskStatusBadge({ status, className }: { status: Enums["task_status"]; className?: string }) {
  return <Render style={TASK[status]} label={humanize(status)} className={className} />;
}
export function RunStatusBadge({ status, className }: { status: Enums["workflow_run_status"]; className?: string }) {
  return <Render style={RUN[status]} label={humanize(status)} className={className} />;
}
export function ApprovalStatusBadge({ status, className }: { status: Enums["approval_status"]; className?: string }) {
  return <Render style={APPROVAL[status]} label={humanize(status)} className={className} />;
}
export function TenderStatusBadge({ status, className }: { status: Enums["tender_status"]; className?: string }) {
  const s = tenderStyle(status);
  return <Render style={{ ...s, spin: false }} label={humanize(status)} className={className} />;
}

export function SimulationBadge() {
  return (
    <Badge variant="warning" title="Simulation: no AI analysis and nothing sent externally">
      Simulation
    </Badge>
  );
}
