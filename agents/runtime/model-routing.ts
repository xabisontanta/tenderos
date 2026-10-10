import type { CostTier } from "@/agents/registry";

export interface ModelChoice {
  tier: CostTier;
  model: string;
  /** USD per 1M tokens; configure from the provider's current price list. */
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface RoutingInput {
  agentTier: CostTier;
  override?: string | null;
  /** Escalate one tier for high-value or complex work. */
  highValue?: boolean;
  complex?: boolean;
}

const ORDER: CostTier[] = ["LOW", "MID", "HIGH"];

/** Model names come from configuration, never hardcoded, so they can change without a deploy. */
export function configuredModels(env: NodeJS.ProcessEnv = process.env): Record<CostTier, string | undefined> {
  return { LOW: env.AI_MODEL_LOW || undefined, MID: env.AI_MODEL_MID || undefined, HIGH: env.AI_MODEL_HIGH || undefined };
}

export function selectTier(input: RoutingInput): CostTier {
  let idx = ORDER.indexOf(input.agentTier);
  if (input.highValue || input.complex) idx = Math.min(idx + 1, ORDER.length - 1);
  return ORDER[idx];
}

export function selectModel(input: RoutingInput, models = configuredModels()): { tier: CostTier; model: string | null } {
  if (input.override) return { tier: input.agentTier, model: input.override };
  const tier = selectTier(input);
  return { tier, model: models[tier] ?? null };
}

export function estimateCostUsd(inputTokens: number, outputTokens: number, price: Pick<ModelChoice, "inputPerMillion" | "outputPerMillion">) {
  return (inputTokens / 1_000_000) * price.inputPerMillion + (outputTokens / 1_000_000) * price.outputPerMillion;
}
