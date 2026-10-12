import { describe, expect, it } from "vitest";
import { AiNotConfiguredError, loadAiConfig, resolveAiEnabled, resolveModel, withTaskCostCeiling } from "@/agents/runtime/ai/config";
import { computeCostUsd, parsePrice, ZERO_USAGE, addUsage } from "@/agents/runtime/ai/pricing";
import { NonRetryableError } from "@/agents/runtime/types";

const FULL_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: "test-key-not-real",
  AI_MODEL_LOW: "model-low",
  AI_MODEL_MID: "model-mid",
  AI_MODEL_HIGH: "model-high",
  AI_PRICE_LOW: "0.1/0.5",
  AI_PRICE_MID: "2/10",
  AI_PRICE_HIGH: "4/20/0.2/5",
};

describe("pricing", () => {
  it("parses input/output with default cache multipliers", () => {
    expect(parsePrice("2/10")).toEqual({ inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, cacheWritePerMillion: 2.5 });
  });
  it("parses explicit cache prices", () => {
    expect(parsePrice("4/20/0.2/5")).toEqual({ inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2, cacheWritePerMillion: 5 });
  });
  it.each(["", "2", "a/b", "-1/5", "2/10/x", "1/2/3/4/5", "NaN/1"])("rejects malformed price %j", (raw) => {
    expect(() => parsePrice(raw)).toThrow(AiNotConfiguredError);
  });

  it("computes real cost from all four token classes and web searches", () => {
    const price = parsePrice("4/20/0.2/5");
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000, webSearchRequests: 3 };
    // 4 + 10 + 0.4 + 0.5 + 3 * 0.01
    expect(computeCostUsd(usage, price, 0.01)).toBeCloseTo(14.93, 6);
  });
  it("costs nothing for zero usage and rounds to the 6 decimals the cost table stores", () => {
    expect(computeCostUsd(ZERO_USAGE, parsePrice("2/10"), 0.01)).toBe(0);
    const tiny = computeCostUsd({ ...ZERO_USAGE, inputTokens: 1 }, parsePrice("2/10"), 0.01);
    expect(tiny).toBe(0.000002);
  });
  it("adds usage", () => {
    expect(addUsage({ ...ZERO_USAGE, inputTokens: 1, webSearchRequests: 1 }, { ...ZERO_USAGE, inputTokens: 2, outputTokens: 3 })).toEqual({
      ...ZERO_USAGE,
      inputTokens: 3,
      outputTokens: 3,
      webSearchRequests: 1,
    });
  });
});

describe("loadAiConfig", () => {
  it("refuses to run without an API key and names every missing variable", () => {
    expect(() => loadAiConfig({})).toThrow(AiNotConfiguredError);
    try {
      loadAiConfig({});
    } catch (e) {
      expect(e).toBeInstanceOf(NonRetryableError);
      expect((e as Error).message).toContain("ANTHROPIC_API_KEY");
    }
  });
  it("treats a blank key as missing", () => {
    expect(() => loadAiConfig({ ...FULL_ENV, ANTHROPIC_API_KEY: "   " })).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("loads defaults for limits", () => {
    const c = loadAiConfig(FULL_ENV);
    expect(c.timeoutMs).toBe(120_000);
    expect(c.maxAttempts).toBe(3);
    expect(c.maxInputTokens).toBe(100_000);
    expect(c.maxTaskCostUsd).toBe(2);
    expect(c.highValueThresholdZar).toBeNull();
  });
  it("rejects invalid numeric settings instead of silently using a default", () => {
    expect(() => loadAiConfig({ ...FULL_ENV, AI_TIMEOUT_MS: "soon" })).toThrow(AiNotConfiguredError);
    expect(() => loadAiConfig({ ...FULL_ENV, AI_MAX_TASK_COST_USD: "-1" })).toThrow(AiNotConfiguredError);
    expect(() => loadAiConfig({ ...FULL_ENV, AI_EFFORT_MID: "extreme" })).toThrow(AiNotConfiguredError);
  });
  it("does not expose the key through JSON serialisation", () => {
    expect(JSON.stringify(loadAiConfig(FULL_ENV))).not.toContain("test-key-not-real");
  });
});

describe("resolveModel", () => {
  const config = loadAiConfig({ ...FULL_ENV, AI_EFFORT_HIGH: "high", AI_HIGH_VALUE_ZAR: "10000000" });

  it("maps the agent tier to the configured model through selectModel", () => {
    expect(resolveModel(config, { agentTier: "MID" })).toMatchObject({ tier: "MID", model: "model-mid" });
    expect(resolveModel(config, { agentTier: "LOW" })).toMatchObject({ tier: "LOW", model: "model-low" });
  });
  it("escalates one tier for complex work", () => {
    expect(resolveModel(config, { agentTier: "MID", complex: true })).toMatchObject({ tier: "HIGH", model: "model-high" });
  });
  it("never falls back to another tier when the tier's model is unset", () => {
    const c = loadAiConfig({ ...FULL_ENV, AI_MODEL_MID: "" });
    expect(() => resolveModel(c, { agentTier: "MID" })).toThrow(/AI_MODEL_MID/);
    expect(() => resolveModel(c, { agentTier: "MID" })).toThrow(AiNotConfiguredError);
  });
  it("refuses a model with no configured price because cost would be unknown", () => {
    const c = loadAiConfig({ ...FULL_ENV, AI_PRICE_MID: "" });
    expect(() => resolveModel(c, { agentTier: "MID" })).toThrow(/AI_PRICE_MID/);
  });
  it("uses the override model only with an override price", () => {
    expect(() => resolveModel(config, { agentTier: "MID", override: "custom-model" })).toThrow(/AI_PRICE_OVERRIDE/);
    const c = loadAiConfig({ ...FULL_ENV, AI_PRICE_OVERRIDE: "1/5" });
    expect(resolveModel(c, { agentTier: "MID", override: "custom-model" })).toMatchObject({ model: "custom-model", price: { inputPerMillion: 1 } });
  });
  it("applies the per-tier effort only when configured", () => {
    expect(resolveModel(config, { agentTier: "HIGH" }).effort).toBe("high");
    expect(resolveModel(config, { agentTier: "MID" }).effort).toBeNull();
  });
  it("decides high value from the configured threshold", () => {
    expect(config.highValueThresholdZar).toBe(10_000_000);
  });
});

describe("withTaskCostCeiling", () => {
  const config = loadAiConfig(FULL_ENV);
  it("lowers the per-task ceiling to what is left of the day's budget, never raises it, never below zero", () => {
    expect(withTaskCostCeiling(config, 0.5).maxTaskCostUsd).toBe(0.5);
    expect(withTaskCostCeiling(config, 50).maxTaskCostUsd).toBe(2);
    expect(withTaskCostCeiling(config, -3).maxTaskCostUsd).toBe(0);
  });
  it("keeps the key usable but out of serialisation", () => {
    const capped = withTaskCostCeiling(config, 1);
    expect(capped.apiKey).toBe("test-key-not-real");
    expect(JSON.stringify(capped)).not.toContain("test-key-not-real");
  });
});

describe("resolveAiEnabled", () => {
  it("is off by default", () => {
    expect(resolveAiEnabled(null, {})).toBe(false);
    expect(resolveAiEnabled({}, {})).toBe(false);
  });
  it("reads the env flag when the settings column does not exist yet", () => {
    expect(resolveAiEnabled({}, { AI_ENABLED: "true" })).toBe(true);
    expect(resolveAiEnabled({}, { AI_ENABLED: "TRUE" })).toBe(true);
    expect(resolveAiEnabled({}, { AI_ENABLED: "1" })).toBe(false);
  });
  it("uses the settings column when it exists, even against the env flag", () => {
    expect(resolveAiEnabled({ ai_enabled: false }, { AI_ENABLED: "true" })).toBe(false);
    expect(resolveAiEnabled({ ai_enabled: true }, {})).toBe(true);
  });
  it("ignores a non-boolean column value", () => {
    expect(resolveAiEnabled({ ai_enabled: "yes" }, {})).toBe(false);
  });
});
