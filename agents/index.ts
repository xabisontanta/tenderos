import type { AgentExecutor } from "./runtime/types";
import { directorIntake } from "./orchestrator/simulated";
import { tenderAnalysis } from "./analysis/simulated";
import { opportunityQualification } from "./qualification/simulated";
import { complianceCheck } from "./compliance/simulated";
import { proposalDraft } from "./proposal/simulated";
import { pricingPrepare } from "./pricing/simulated";
import { qaReview } from "./qa/simulated";
import { submissionExecute } from "./submission/simulated";

/** Executors by task type. Live (model-backed) executors will register alongside these. */
export const SIMULATED_EXECUTORS: Record<string, AgentExecutor<unknown>> = Object.fromEntries(
  [directorIntake, tenderAnalysis, opportunityQualification, complianceCheck, proposalDraft, pricingPrepare, qaReview, submissionExecute].map(
    (e) => [e.taskType, e as AgentExecutor<unknown>],
  ),
);

export function getExecutor(taskType: string): AgentExecutor<unknown> | undefined {
  return SIMULATED_EXECUTORS[taskType];
}
