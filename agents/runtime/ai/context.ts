import { NonRetryableError, type AgentContext, type CostRecord } from "../types";
import type { AiRuntime } from "./runtime";

/** Cost row for a real run that made no model call (for example, a tender with no documents to read). */
export const RULES_COST: CostRecord = { provider: "rules", model: "none", inputTokens: 0, outputTokens: 0, costUsd: 0, isSimulated: false };

/** The AI runtime for an AI executor. Missing means the engine ran it in the wrong mode, which is a bug, not a retry. */
export function requireAi(ctx: AgentContext): AiRuntime {
  if (!ctx.ai) throw new NonRetryableError("The AI runtime was not provided to this executor; it only runs in AI mode on real tenders");
  return ctx.ai;
}
