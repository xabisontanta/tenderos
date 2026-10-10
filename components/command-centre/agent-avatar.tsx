import {
  Bot,
  Briefcase,
  Calculator,
  ClipboardCheck,
  FileSearch,
  FileText,
  FolderLock,
  Mail,
  Radar,
  Scale,
  Send,
  ShieldCheck,
  TimerReset,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  tender_director: Briefcase,
  tender_discovery: Radar,
  opportunity_qualification: Scale,
  tender_analyst: FileSearch,
  compliance: ShieldCheck,
  document_manager: FolderLock,
  proposal_writer: FileText,
  pricing: Calculator,
  forms: ClipboardCheck,
  quality_assurance: ClipboardCheck,
  submission: Send,
  communications: Mail,
  deadline: TimerReset,
  tender_intelligence: TrendingUp,
};

export const ACCENTS: Record<string, { ring: string; bg: string; text: string; border: string; glow: string; pulse: string }> = {
  violet: {
    ring: "ring-violet-500/40",
    bg: "bg-violet-500/15",
    text: "text-violet-300",
    border: "border-violet-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-violet-500/40",
    pulse: "oklch(0.7 0.18 300)",
  },
  sky: {
    ring: "ring-sky-500/40",
    bg: "bg-sky-500/15",
    text: "text-sky-300",
    border: "border-sky-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-sky-500/40",
    pulse: "oklch(0.75 0.14 230)",
  },
  indigo: {
    ring: "ring-indigo-500/40",
    bg: "bg-indigo-500/15",
    text: "text-indigo-300",
    border: "border-indigo-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-indigo-500/40",
    pulse: "oklch(0.68 0.16 275)",
  },
  emerald: {
    ring: "ring-emerald-500/40",
    bg: "bg-emerald-500/15",
    text: "text-emerald-300",
    border: "border-emerald-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-emerald-500/40",
    pulse: "oklch(0.75 0.15 160)",
  },
  amber: {
    ring: "ring-amber-500/40",
    bg: "bg-amber-500/15",
    text: "text-amber-300",
    border: "border-amber-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-amber-500/40",
    pulse: "oklch(0.8 0.15 80)",
  },
  rose: {
    ring: "ring-rose-500/40",
    bg: "bg-rose-500/15",
    text: "text-rose-300",
    border: "border-rose-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-rose-500/40",
    pulse: "oklch(0.7 0.18 10)",
  },
  cyan: {
    ring: "ring-cyan-500/40",
    bg: "bg-cyan-500/15",
    text: "text-cyan-300",
    border: "border-cyan-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-cyan-500/40",
    pulse: "oklch(0.8 0.12 200)",
  },
  teal: {
    ring: "ring-teal-500/40",
    bg: "bg-teal-500/15",
    text: "text-teal-300",
    border: "border-teal-500/30",
    glow: "shadow-[0_0_40px_-12px] shadow-teal-500/40",
    pulse: "oklch(0.78 0.12 180)",
  },
  slate: {
    ring: "ring-slate-400/40",
    bg: "bg-slate-400/15",
    text: "text-slate-300",
    border: "border-slate-400/30",
    glow: "shadow-[0_0_40px_-12px] shadow-slate-400/40",
    pulse: "oklch(0.75 0.02 250)",
  },
};

export function accentFor(accent: string | null | undefined) {
  return ACCENTS[accent ?? "slate"] ?? ACCENTS.slate;
}

export function AgentAvatar({ slug, accent, size = "md", active = false }: { slug: string; accent: string; size?: "sm" | "md" | "lg"; active?: boolean }) {
  const Icon = ICONS[slug] ?? Bot;
  const a = accentFor(accent);
  const dims = size === "sm" ? "size-7" : size === "lg" ? "size-12" : "size-9";
  const icon = size === "sm" ? "size-3.5" : size === "lg" ? "size-6" : "size-4.5";
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-lg ring-1", dims, a.bg, a.ring, active && "agent-pulse")}
      style={{ ["--pulse" as string]: a.pulse }}
      aria-hidden
    >
      <Icon className={cn(icon, a.text)} />
    </span>
  );
}
