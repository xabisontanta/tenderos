import type { CostTier } from "@/agents/registry";
import { configuredModels, selectModel, type RoutingInput } from "../model-routing";
import { AiNotConfiguredError } from "./errors";
import { parsePrice, type TokenPrice } from "./pricing";

export { AiNotConfiguredError } from "./errors";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const TIERS: readonly CostTier[] = ["LOW", "MID", "HIGH"];

export interface AiConfig {
  /** Held in a non-enumerable property so it cannot leak through JSON.stringify or a log line. */
  readonly apiKey: string;
  models: Record<CostTier, string | undefined>;
  prices: Record<CostTier, TokenPrice | undefined>;
  overridePrice: TokenPrice | undefined;
  efforts: Record<CostTier, Effort | null>;
  timeoutMs: number;
  maxAttempts: number;
  /** Prompts above this many input tokens are refused. Keep it at or below 100000 so the cheapest tier's long-prompt price never applies. */
  maxInputTokens: number;
  maxOutputTokens: number;
  /** A task that has spent this much refuses to start another model call. */
  maxTaskCostUsd: number;
  /** Tenders estimated at or above this value are escalated one model tier. Null disables escalation. */
  highValueThresholdZar: number | null;
  /** Largest chunk of tender document text sent in one request, in characters. */
  chunkChars: number;
  webSearchUsd: number;
  /** Deployment-wide fallback for the per-organisation web research flag. */
  webResearchEnv: boolean;
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number | null, opts: { min?: number; integer?: boolean } = {}): number | null {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < (opts.min ?? 0) || (opts.integer && !Number.isInteger(n))) {
    throw new AiNotConfiguredError(`${name} must be ${opts.integer ? "a whole " : "a "}number >= ${opts.min ?? 0} (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Reads AI settings from the environment. Throws when anything required is
 * missing or malformed; there is deliberately no default model, no default
 * price and no fallback to the rules-only path.
 */
export function loadAiConfig(env: Env = process.env): AiConfig {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new AiNotConfiguredError("ANTHROPIC_API_KEY is not set; real AI execution is refused until it is configured");

  const prices = {} as Record<CostTier, TokenPrice | undefined>;
  const efforts = {} as Record<CostTier, Effort | null>;
  for (const tier of TIERS) {
    const rawPrice = env[`AI_PRICE_${tier}`]?.trim();
    prices[tier] = rawPrice ? parsePrice(rawPrice, `AI_PRICE_${tier}`) : undefined;
    const rawEffort = env[`AI_EFFORT_${tier}`]?.trim().toLowerCase();
    if (rawEffort && !(EFFORTS as readonly string[]).includes(rawEffort)) {
      throw new AiNotConfiguredError(`AI_EFFORT_${tier} must be one of ${EFFORTS.join(", ")} (got ${JSON.stringify(rawEffort)})`);
    }
    efforts[tier] = (rawEffort as Effort | undefined) ?? null;
  }
  const rawOverride = env.AI_PRICE_OVERRIDE?.trim();

  const config = {
    models: configuredModels(env),
    prices,
    overridePrice: rawOverride ? parsePrice(rawOverride, "AI_PRICE_OVERRIDE") : undefined,
    efforts,
    timeoutMs: num(env, "AI_TIMEOUT_MS", 120_000, { min: 1000, integer: true })!,
    maxAttempts: num(env, "AI_MAX_ATTEMPTS", 3, { min: 1, integer: true })!,
    maxInputTokens: num(env, "AI_MAX_INPUT_TOKENS", 100_000, { min: 1000, integer: true })!,
    maxOutputTokens: num(env, "AI_MAX_OUTPUT_TOKENS", 32_000, { min: 256, integer: true })!,
    maxTaskCostUsd: num(env, "AI_MAX_TASK_COST_USD", 2, { min: 0 })!,
    highValueThresholdZar: num(env, "AI_HIGH_VALUE_ZAR", null, { min: 0 }),
    chunkChars: num(env, "AI_CHUNK_CHARS", 100_000, { min: 2000, integer: true })!,
    webSearchUsd: num(env, "AI_WEB_SEARCH_COST_USD", 0.01, { min: 0 })!,
    webResearchEnv: env.AI_WEB_RESEARCH_ENABLED?.trim().toLowerCase() === "true",
  };
  Object.defineProperty(config, "apiKey", { value: apiKey, enumerable: false });
  return config as AiConfig;
}

/** A copy of the config whose per-task ceiling is no higher than `usd` (for example what is left of the day's budget). The key stays hidden. */
export function withTaskCostCeiling(config: AiConfig, usd: number): AiConfig {
  const copy = { ...config, maxTaskCostUsd: Math.min(config.maxTaskCostUsd, Math.max(0, usd)) };
  Object.defineProperty(copy, "apiKey", { value: config.apiKey, enumerable: false });
  return copy as AiConfig;
}

/**
 * Whether AI execution is switched on for an organisation. The settings column
 * `ai_enabled` decides when it exists; until it does, the deployment flag
 * AI_ENABLED=true does. Off unless explicitly on.
 */
export function resolveAiEnabled(settings: object | null | undefined, env: Env = process.env): boolean {
  const column = (settings as Record<string, unknown> | null | undefined)?.ai_enabled;
  if (typeof column === "boolean") return column;
  return env.AI_ENABLED?.trim().toLowerCase() === "true";
}

/** Whether Anthropic web search may run for an organisation: its flag when the column exists, else the deployment flag. */
export function resolveWebResearchEnabled(settings: object | null | undefined, env: Env = process.env): boolean {
  const column = (settings as Record<string, unknown> | null | undefined)?.ai_web_research_enabled;
  if (typeof column === "boolean") return column;
  return env.AI_WEB_RESEARCH_ENABLED?.trim().toLowerCase() === "true";
}

export interface ResolvedModel {
  tier: CostTier;
  model: string;
  price: TokenPrice;
  effort: Effort | null;
}

/** Chooses the model for a call with selectModel and attaches its price. Refuses rather than substituting another tier. */
export function resolveModel(config: AiConfig, routing: RoutingInput): ResolvedModel {
  const { tier, model } = selectModel(routing, config.models);
  if (!model) throw new AiNotConfiguredError(`AI_MODEL_${tier} is not set; the ${tier} tier has no model and no other tier is used in its place`);
  const price = routing.override ? config.overridePrice : config.prices[tier];
  if (!price) {
    throw new AiNotConfiguredError(
      routing.override
        ? `AI_PRICE_OVERRIDE is not set; the agent's model override has no price, so its cost and the daily budget cannot be tracked`
        : `AI_PRICE_${tier} is not set; without a price the cost of ${model} cannot be tracked against the budget`,
    );
  }
  return { tier, model, price, effort: config.efforts[tier] };
}
