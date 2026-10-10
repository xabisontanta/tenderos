import type { AgentSlug } from "@/agents/registry";
import type { TenderStatus } from "@/lib/domain/tender-state";

export interface PlanStep {
  key: string;
  agent: AgentSlug;
  kind: "agent" | "approval";
  /** Executor task type (agent steps) or approval task type. */
  taskType: string;
  title: string;
  /** Handoff type used when work arrives at this step. */
  handoffType: string;
  /** Tender transitions applied when the step starts. */
  onStart: TenderStatus[];
  priority?: number;
  timeoutSeconds?: number;
}

/** The ordered steps of the simulated bid workflow. */
export const SIMULATED_BID_PLAN: PlanStep[] = [
  {
    key: "intake",
    agent: "tender_director",
    kind: "agent",
    taskType: "director.intake",
    title: "Plan tender workflow",
    handoffType: "NEW_TENDER",
    onStart: ["INGESTING"],
  },
  {
    key: "analysis",
    agent: "tender_analyst",
    kind: "agent",
    taskType: "analysis.extract",
    title: "Extract tender requirements",
    handoffType: "TENDER_INTAKE",
    onStart: ["ANALYSING"],
  },
  {
    key: "qualification",
    agent: "opportunity_qualification",
    kind: "agent",
    taskType: "qualification.assess",
    title: "Assess bid fit",
    handoffType: "REQUIREMENTS_EXTRACTED",
    onStart: ["QUALIFYING"],
  },
  {
    key: "compliance",
    agent: "compliance",
    kind: "agent",
    taskType: "compliance.check",
    title: "Check compliance documents",
    handoffType: "TENDER_QUALIFIED",
    onStart: ["COMPLIANCE_REVIEW"],
  },
  {
    key: "proposal",
    agent: "proposal_writer",
    kind: "agent",
    taskType: "proposal.draft",
    title: "Draft proposal outline",
    handoffType: "COMPLIANCE_REVIEWED",
    onStart: ["PREPARING_BID"],
  },
  {
    key: "pricing",
    agent: "pricing",
    kind: "agent",
    taskType: "pricing.prepare",
    title: "Structure pricing schedule",
    handoffType: "PROPOSAL_DRAFTED",
    onStart: ["PRICING"],
  },
  {
    key: "qa",
    agent: "quality_assurance",
    kind: "agent",
    taskType: "qa.review",
    title: "Independent bid review",
    handoffType: "PRICING_STRUCTURED",
    onStart: ["QUALITY_ASSURANCE"],
    priority: 6,
  },
  {
    key: "approval",
    agent: "submission",
    kind: "approval",
    taskType: "approval.bid_submission",
    title: "Await bid submission approval",
    handoffType: "QA_COMPLETED",
    onStart: [],
  },
  {
    key: "submission",
    agent: "submission",
    kind: "agent",
    taskType: "submission.execute",
    title: "Verify and record submission",
    handoffType: "SUBMISSION_APPROVED",
    onStart: ["SUBMITTING"],
    priority: 8,
  },
];
