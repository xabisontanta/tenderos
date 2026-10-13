import { AiNotConfiguredError } from "./errors";

/** USD per 1M tokens. Configured, never hard-coded, because provider prices change. */
export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface AiUsage {
  /** Input tokens that were not served from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
}

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0 };

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
  };
}

/** All input the model read, however it was billed. */
export function totalInputTokens(u: AiUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

/**
 * Parses "input/output[/cacheRead[/cacheWrite]]" in USD per million tokens.
 * Cache prices default to the standard multipliers (read 0.1x, 5-minute write
 * 1.25x of the input price); set them explicitly for models that differ.
 */
export function parsePrice(raw: string, name = "price"): TokenPrice {
  const parts = raw.split("/").map((p) => p.trim());
  const nums = parts.map((p) => (p === "" ? Number.NaN : Number(p)));
  if (raw.trim() === "" || parts.length < 2 || parts.length > 4 || nums.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new AiNotConfiguredError(`${name} must look like "input/output[/cacheRead[/cacheWrite]]" in USD per million tokens (got ${JSON.stringify(raw)})`);
  }
  const [input, output, cacheRead = input * 0.1, cacheWrite = input * 1.25] = nums;
  return { inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheRead, cacheWritePerMillion: cacheWrite };
}

/** Real cost of one or more calls in USD, rounded to the 6 decimals cost_usage stores. */
export function computeCostUsd(usage: AiUsage, price: TokenPrice, webSearchUsd: number): number {
  const tokens =
    (usage.inputTokens * price.inputPerMillion +
      usage.outputTokens * price.outputPerMillion +
      usage.cacheReadTokens * price.cacheReadPerMillion +
      usage.cacheWriteTokens * price.cacheWritePerMillion) /
    1_000_000;
  return Math.round((tokens + usage.webSearchRequests * webSearchUsd) * 1_000_000) / 1_000_000;
}
