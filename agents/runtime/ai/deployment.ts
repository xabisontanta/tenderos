import { getAgentDefinition, type CostTier } from "@/agents/registry";
import { REAL_EXECUTORS } from "@/agents";
import { loadAiConfig } from "./config";
import { AiNotConfiguredError } from "./errors";
import { parsePrice } from "./pricing";

type Env = Record<string, string | undefined>;

export interface AiDeploymentStatus {
  /** `AI_ENABLED=true`: the deployment lets organisations use AI at all. */
  allowed: boolean;
  /** Everything that would stop an AI step from starting, in plain words. Names variables, never values. */
  problems: string[];
}

const ORDER: CostTier[] = ["LOW", "MID", "HIGH"];

/** Tiers a model-backed step can run on: each AI agent's own tier, and the tier above it, which complex or high-value work moves up to. */
export function aiTiersInUse(): CostTier[] {
  const used = new Set<CostTier>();
  for (const executor of Object.values(REAL_EXECUTORS)) {
    const tier = getAgentDefinition(executor.agent)?.modelTier;
    if (!tier) continue;
    used.add(tier);
    used.add(ORDER[Math.min(ORDER.indexOf(tier) + 1, ORDER.length - 1)]);
  }
  return ORDER.filter((t) => used.has(t));
}

/**
 * What the deployment would need before an AI step could start, checked the same way the engine checks it
 * (`loadAiConfig`, `resolveModel`) but listed instead of thrown, so Settings can say what is missing before a
 * bid fails on it. It reads the environment of the process it runs in: on a deployment where the web app and the
 * worker have different environments, the worker's is the one that counts.
 */
export function describeAiDeployment(env: Env = process.env): AiDeploymentStatus {
  const problems: string[] = [];
  const allowed = env.AI_ENABLED?.trim().toLowerCase() === "true";
  if (!allowed) problems.push("AI_ENABLED is not set to true, so the deployment does not allow AI at all");
  if (!env.ANTHROPIC_API_KEY?.trim()) problems.push("ANTHROPIC_API_KEY is not set");
  for (const tier of aiTiersInUse()) {
    if (!env[`AI_MODEL_${tier}`]?.trim()) problems.push(`AI_MODEL_${tier} is not set (no model for the ${tier} tier)`);
    const price = env[`AI_PRICE_${tier}`]?.trim();
    if (!price) {
      problems.push(`AI_PRICE_${tier} is not set (without a price the cost cannot be tracked against the budget)`);
      continue;
    }
    try {
      parsePrice(price, `AI_PRICE_${tier}`);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  // Anything else loadAiConfig refuses (a malformed timeout, effort or limit) that is not already listed.
  if (env.ANTHROPIC_API_KEY?.trim()) {
    try {
      loadAiConfig(env);
    } catch (err) {
      const message = err instanceof AiNotConfiguredError ? err.message : "The AI settings could not be read";
      if (!problems.some((p) => message.startsWith(p.split(" ")[0]))) problems.push(message);
    }
  }
  return { allowed, problems };
}
