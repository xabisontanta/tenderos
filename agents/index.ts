import type { AgentExecutor } from "./runtime/types";
import { directorIntake } from "./orchestrator/simulated";
import { tenderAnalysis } from "./analysis/simulated";
import { tenderAnalysisReal } from "./analysis/real";
import { opportunityQualification } from "./qualification/simulated";
import { opportunityQualificationReal } from "./qualification/real";
import { complianceCheck } from "./compliance/simulated";
import { proposalDraft } from "./proposal/simulated";
import { proposalDraftReal } from "./proposal/real";
import { pricingPrepare } from "./pricing/simulated";
import { qaReview } from "./qa/simulated";
import { submissionExecute } from "./submission/simulated";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byType = (executors: Array<AgentExecutor<any>>): Record<string, AgentExecutor<unknown>> =>
  Object.fromEntries(executors.map((e) => [e.taskType, e as AgentExecutor<unknown>]));

/**
 * Simulated and rules-only executors by task type. These run for simulation
 * runs and, on real tenders, whenever AI is off. They are the default.
 */
export const SIMULATED_EXECUTORS: Record<string, AgentExecutor<unknown>> = byType([
  directorIntake,
  tenderAnalysis,
  opportunityQualification,
  complianceCheck,
  proposalDraft,
  pricingPrepare,
  qaReview,
  submissionExecute,
]);

/** Model-backed executors. Used only on real tenders for organisations with AI switched on. */
export const REAL_EXECUTORS: Record<string, AgentExecutor<unknown>> = byType([tenderAnalysisReal, opportunityQualificationReal, proposalDraftReal]);

export interface ExecutionMode {
  /** The run is a simulation: no model is ever called. */
  simulation: boolean;
  /** AI is switched on for the organisation (see resolveAiEnabled). */
  aiEnabled: boolean;
}

/** Simulation and rules-only behaviour is the default; a model-backed executor needs both a real run and AI switched on. */
export function getExecutor(taskType: string, mode: ExecutionMode = { simulation: true, aiEnabled: false }): AgentExecutor<unknown> | undefined {
  if (!mode.simulation && mode.aiEnabled && REAL_EXECUTORS[taskType]) return REAL_EXECUTORS[taskType];
  return SIMULATED_EXECUTORS[taskType];
}
