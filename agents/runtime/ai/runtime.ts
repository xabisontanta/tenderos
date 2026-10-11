import type { AgentSlug, CostTier } from "@/agents/registry";
import type { Logger } from "@/lib/log";
import type { RoutingInput } from "../model-routing";
import type { CostRecord } from "../types";
import type { AiClient } from "./client";
import { resolveModel, type AiConfig, type ResolvedModel } from "./config";
import type { DocumentSource } from "./documents";
import { AiBudgetError } from "./errors";
import { ZERO_USAGE, addUsage, computeCostUsd, totalInputTokens, type AiUsage } from "./pricing";

/** Tracks what one task execution has spent, across every call it makes. */
export class CostMeter {
  private usage: AiUsage = ZERO_USAGE;
  private cost = 0;
  private readonly models = new Set<string>();
  calls = 0;

  constructor(private readonly limits: Pick<AiConfig, "maxTaskCostUsd" | "webSearchUsd">) {}

  /** Adds a call and returns its cost in USD. */
  record(model: ResolvedModel, usage: AiUsage): number {
    const callCost = computeCostUsd(usage, model.price, this.limits.webSearchUsd);
    this.usage = addUsage(this.usage, usage);
    this.cost = Math.round((this.cost + callCost) * 1_000_000) / 1_000_000;
    this.models.add(model.model);
    this.calls++;
    return callCost;
  }

  get costUsd(): number {
    return this.cost;
  }

  get totals(): AiUsage {
    return this.usage;
  }

  /** Refuses to start a call when the task has spent its ceiling or this call's input alone would pass it. */
  assertCanSpend(estimatedInputUsd: number): void {
    if (this.cost + estimatedInputUsd > this.limits.maxTaskCostUsd) {
      throw new AiBudgetError(
        `This task has spent $${this.cost.toFixed(4)} of its $${this.limits.maxTaskCostUsd.toFixed(2)} ceiling (AI_MAX_TASK_COST_USD); another model call was not started`,
      );
    }
  }

  /** The cost row the engine stores in cost_usage: real tokens, real USD. */
  toCostRecord(): CostRecord {
    return {
      provider: "anthropic",
      model: [...this.models].join("+") || "none",
      inputTokens: totalInputTokens(this.usage),
      outputTokens: this.usage.outputTokens,
      costUsd: this.cost,
      isSimulated: false,
    };
  }
}

export interface AiRuntime {
  client: AiClient;
  config: AiConfig;
  agent: { slug: AgentSlug; tier: CostTier; modelOverride: string | null };
  meter: CostMeter;
  logger: Logger;
  documents: DocumentSource;
  /** Aborted by the engine when the task times out. */
  signal: AbortSignal;
  /** Whether Anthropic web search may be used for this organisation. */
  webResearchEnabled: boolean;
  /** Model for a call, chosen with selectModel. Throws AiNotConfiguredError rather than substituting another tier. */
  resolve(flags?: Pick<RoutingInput, "highValue" | "complex">): ResolvedModel;
}

export function createAiRuntime(opts: {
  client: AiClient;
  config: AiConfig;
  agent: AiRuntime["agent"];
  logger: Logger;
  documents: DocumentSource;
  signal: AbortSignal;
  webResearchEnabled: boolean;
}): AiRuntime {
  const resolve: AiRuntime["resolve"] = (flags = {}) => resolveModel(opts.config, { agentTier: opts.agent.tier, override: opts.agent.modelOverride, ...flags });
  resolve(); // fail now, before any work, if the agent's own model or price is not configured
  return { ...opts, meter: new CostMeter(opts.config), resolve };
}
