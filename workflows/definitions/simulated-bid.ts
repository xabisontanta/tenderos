import type { TenderStatus } from "@/lib/domain/tender-state";
import type { DomainEvent } from "@/agents/runtime/types";
import type { QualificationOutput } from "@/agents/qualification/schema";
import type { ComplianceOutput } from "@/agents/compliance/schema";
import type { QaOutput } from "@/agents/qa/schema";
import type { SubmissionOutput } from "@/agents/submission/schema";
import { SIMULATED_BID_PLAN, type PlanStep } from "./plan";

export type NextAction =
  | { type: "step"; key: string; payload: Record<string, unknown> }
  | { type: "complete"; outcome: string }
  | { type: "block"; reason: string };

export interface StepResolution {
  /** Tender transitions to apply after the step completes. */
  tender: TenderStatus[];
  next: NextAction;
  events?: DomainEvent[];
}

export interface WorkflowDefinition {
  key: string;
  version: number;
  steps: PlanStep[];
  firstStep: string;
  resolve(stepKey: string, output: unknown, run: { isSimulation: boolean }): StepResolution;
}

function nextStepAfter(key: string): PlanStep | undefined {
  const i = SIMULATED_BID_PLAN.findIndex((s) => s.key === key);
  return SIMULATED_BID_PLAN[i + 1];
}

function forward(key: string, payload: Record<string, unknown>, tender: TenderStatus[] = []): StepResolution {
  const next = nextStepAfter(key);
  if (!next) throw new Error(`No step after ${key}`);
  return { tender, next: { type: "step", key: next.key, payload } };
}

/**
 * Decides what happens after each step. Pure: given a step's validated output,
 * returns tender transitions and the next action. The engine applies them.
 */
export const simulatedBidWorkflow: WorkflowDefinition = {
  key: "simulated_bid",
  version: 1,
  steps: SIMULATED_BID_PLAN,
  firstStep: "intake",
  resolve(stepKey, output, run) {
    switch (stepKey) {
      case "intake":
        return forward(stepKey, { summary: "Tender accepted for analysis" });
      case "analysis":
        return forward(stepKey, { summary: "Requirements extracted from tender record" });
      case "qualification": {
        const q = output as QualificationOutput;
        if (q.decision === "REJECTED") {
          return { tender: ["REJECTED"], next: { type: "complete", outcome: "REJECTED" } };
        }
        return forward(stepKey, { fit_score: q.fit_score, confirmation_required: q.confirmation_required }, ["QUALIFIED"]);
      }
      case "compliance": {
        const c = output as ComplianceOutput;
        if (c.outcome === "INCOMPLETE" && !run.isSimulation) {
          return { tender: ["MISSING_INFORMATION"], next: { type: "block", reason: `Missing compliance items: ${c.missing.join(", ")}` } };
        }
        return forward(stepKey, { missing: c.missing, continued_in_simulation: c.continued_in_simulation });
      }
      case "proposal":
        return forward(stepKey, { summary: "Proposal outline ready" });
      case "pricing":
        return forward(stepKey, { summary: "Pricing schedule structured" });
      case "qa": {
        const qa = output as QaOutput;
        if (qa.verdict === "FAIL") {
          return { tender: ["QA_FAILED"], next: { type: "block", reason: `QA failed: ${qa.open_issues.join("; ")}` } };
        }
        return forward(stepKey, { verdict: qa.verdict, open_issues: qa.open_issues }, ["READY_FOR_APPROVAL"]);
      }
      case "approval":
        return forward(stepKey, { approval_status: "APPROVED" }, ["APPROVED"]);
      case "submission": {
        const s = output as SubmissionOutput;
        if (s.status === "ACTION_REQUIRED") {
          return { tender: [], next: { type: "block", reason: s.receipt_note } };
        }
        return { tender: ["SUBMITTED"], next: { type: "complete", outcome: "SUBMITTED_SIMULATION" } };
      }
      default:
        throw new Error(`Unknown step ${stepKey}`);
    }
  },
};

export const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [simulatedBidWorkflow.key]: simulatedBidWorkflow,
};

export function getStep(def: WorkflowDefinition, key: string): PlanStep {
  const s = def.steps.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown step ${key} in ${def.key}`);
  return s;
}
