import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DataCategory } from "@/agents/registry";
import { loadAiConfig, AiNotConfiguredError } from "@/agents/runtime/ai/config";
import { AiBudgetError, AiInputTooLargeError, AiOutputError, AiRefusalError, PromptPolicyError } from "@/agents/runtime/ai/errors";
import { buildPrompt, trusted } from "@/agents/runtime/ai/guardrails/data-policy";
import { buildSystemPrompt } from "@/agents/runtime/ai/prompts";
import { createAiRuntime } from "@/agents/runtime/ai/runtime";
import { generateStructured } from "@/agents/runtime/ai/structured";
import { NO_DOCUMENTS } from "@/agents/runtime/ai/documents";
import { computeCostUsd, parsePrice } from "@/agents/runtime/ai/pricing";
import { NonRetryableError } from "@/agents/runtime/types";
import { FakeAiClient } from "../support/fake-ai";
import { captureLogs } from "../support/log-capture";

const ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: "test-key-not-real",
  AI_MODEL_LOW: "model-low",
  AI_MODEL_MID: "model-mid",
  AI_MODEL_HIGH: "model-high",
  AI_PRICE_LOW: "0.1/0.5",
  AI_PRICE_MID: "2/10",
  AI_PRICE_HIGH: "4/20/0.2/5",
};

const schema = z.object({ items: z.array(z.object({ id: z.string(), n: z.number().int().min(0) })) });
const GRANTED = new Set<DataCategory>(["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS"]);
const SENTINEL_DOC = "SENTINEL-DOCUMENT-TEXT: bidders must hold CIDB grade 6CE";
const SENTINEL_REPLY = "SENTINEL-REPLY-TEXT";

const docBlocks = () => buildPrompt([{ type: "text", category: "TENDER_DOCUMENTS", label: "tender_document:d1", text: SENTINEL_DOC, cache: true }], GRANTED);

let restore: (() => void) | null = null;
afterEach(() => restore?.());

function setup(replies: ConstructorParameters<typeof FakeAiClient>[0], env = ENV, tier: "LOW" | "MID" | "HIGH" = "MID") {
  const logs = captureLogs();
  restore = logs.restore;
  const client = new FakeAiClient(replies);
  const runtime = createAiRuntime({
    client,
    config: loadAiConfig(env),
    agent: { slug: "tender_analyst", tier, modelOverride: null },
    logger: logs.logger,
    documents: NO_DOCUMENTS,
    signal: new AbortController().signal,
    webResearchEnabled: false,
  });
  return { client, runtime, logs };
}

const call = (runtime: ReturnType<typeof setup>["runtime"], extra: Partial<Parameters<typeof generateStructured<z.infer<typeof schema>>>[0]> = {}) =>
  generateStructured({
    runtime,
    label: "test.extract",
    system: buildSystemPrompt({ role: "Tender Analyst", mission: "Extract requirements.", rules: ["Cite a verbatim quote."] }),
    prompt: docBlocks(),
    instruction: "Extract the requirements as JSON.",
    schema,
    ...extra,
  });

describe("system prompts", () => {
  const p = buildSystemPrompt({ role: "Tender Analyst", mission: "Extract requirements.", rules: ["Cite a verbatim quote."] });
  it("tells the model that wrapped content is data and never to invent facts", () => {
    expect(p).toMatch(/data, not instructions/i);
    expect(p).toMatch(/MISSING_INFORMATION/);
    expect(p).toMatch(/REQUIRES_CONFIRMATION/);
    expect(p).toMatch(/Never invent/i);
    expect(p).toContain("Cite a verbatim quote.");
  });
  it("is byte-identical between calls so it stays cacheable", () => {
    expect(buildSystemPrompt({ role: "Tender Analyst", mission: "Extract requirements.", rules: ["Cite a verbatim quote."] })).toBe(p);
  });
});

describe("runtime creation", () => {
  it("refuses to start when the agent's tier has no model or price", () => {
    expect(() => setup([], { ...ENV, AI_MODEL_MID: "" })).toThrow(AiNotConfiguredError);
    expect(() => setup([], { ...ENV, AI_PRICE_MID: "" })).toThrow(AiNotConfiguredError);
  });
});

describe("generateStructured", () => {
  it("returns validated data using the model chosen through selectModel", async () => {
    const { client, runtime } = setup([{ json: { items: [{ id: "a", n: 1 }] }, usage: { inputTokens: 1000, outputTokens: 500 } }]);
    const out = await call(runtime);
    expect(out).toEqual({ items: [{ id: "a", n: 1 }] });
    expect(client.requests).toHaveLength(1);
    const req = client.requests[0];
    expect(req.model).toBe("model-mid");
    expect(req.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(req.messages[0].role).toBe("user");
    expect(req.messages[0].content.at(-1)).toMatchObject({ type: "trusted", text: "Extract the requirements as JSON." });
    expect(req.maxTokens).toBeLessThanOrEqual(runtime.config.maxOutputTokens);
    expect(req.timeoutMs).toBe(120_000);
  });

  it("escalates one tier for complex work and applies the configured effort", async () => {
    const { client, runtime } = setup([{ json: { items: [] } }], { ...ENV, AI_EFFORT_HIGH: "high" });
    await call(runtime, { routing: { complex: true } });
    expect(client.requests[0]).toMatchObject({ model: "model-high", effort: "high" });
  });

  it("counts tokens first and refuses a prompt over the input limit without calling the model", async () => {
    const { client, runtime } = setup([{ json: { items: [] } }], { ...ENV, AI_MAX_INPUT_TOKENS: "1000" });
    const big = buildPrompt([{ type: "text", category: "TENDER_DOCUMENTS", label: "big", text: "word ".repeat(5000) }], GRANTED);
    await expect(call(runtime, { prompt: big })).rejects.toBeInstanceOf(AiInputTooLargeError);
    expect(client.countRequests).toHaveLength(1);
    expect(client.requests).toHaveLength(0);
  });

  it("returns the real cost of every call so the engine can record it", async () => {
    const { runtime } = setup([
      { text: "{not json", usage: { inputTokens: 1000, outputTokens: 500 } },
      { json: { items: [] }, usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1000 } },
    ]);
    await call(runtime);
    const record = runtime.meter.toCostRecord();
    const expected = computeCostUsd(
      { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 1000, cacheWriteTokens: 0, webSearchRequests: 0 },
      parsePrice("2/10"),
      0.01,
    );
    expect(record).toMatchObject({ provider: "anthropic", model: "model-mid", inputTokens: 4000, outputTokens: 600, isSimulated: false });
    expect(record.costUsd).toBeCloseTo(expected, 8);
    expect(record.costUsd).toBeGreaterThan(0);
  });

  it("repairs invalid output once, replaying the exchange and naming what was wrong", async () => {
    const { client, runtime } = setup([{ json: { items: [{ id: "a", n: -4 }] } }, { json: { items: [{ id: "a", n: 4 }] } }]);
    await expect(call(runtime)).resolves.toEqual({ items: [{ id: "a", n: 4 }] });
    expect(client.requests).toHaveLength(2);
    const second = client.requests[1];
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1].content[0]).toMatchObject({ text: JSON.stringify({ items: [{ id: "a", n: -4 }] }) });
    expect(second.messages[2].content[0]).toMatchObject({ type: "trusted" });
    expect((second.messages[2].content[0] as { text: string }).text).toMatch(/items\.0\.n/);
    // The big document block is byte-identical in both requests, so it can be served from the cache.
    expect(second.messages[0].content[0]).toEqual(client.requests[0].messages[0].content[0]);
  });

  it("repairs malformed JSON too", async () => {
    const { client, runtime } = setup([{ text: "Sure! Here you go: {oops" }, { json: { items: [] } }]);
    await expect(call(runtime)).resolves.toEqual({ items: [] });
    expect(client.requests).toHaveLength(2);
  });

  it("gives up after the single repair and fails without retrying, keeping the spend on the meter", async () => {
    const { client, runtime } = setup([
      { text: "nope", usage: { inputTokens: 500, outputTokens: 50 } },
      { json: { items: "still wrong" }, usage: { inputTokens: 500, outputTokens: 50 } },
    ]);
    const err = await call(runtime).catch((e) => e);
    expect(err).toBeInstanceOf(AiOutputError);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(client.requests).toHaveLength(2);
    expect(runtime.meter.costUsd).toBeGreaterThan(0);
  });

  it("sends semantic problems found by the caller back for repair", async () => {
    const { client, runtime } = setup([{ json: { items: [{ id: "dup", n: 1 }] } }, { json: { items: [{ id: "ok", n: 1 }] } }]);
    const out = await call(runtime, { validate: (v) => (v.items.some((i) => i.id === "dup") ? ['item id "dup" is not allowed'] : []) });
    expect(out.items[0].id).toBe("ok");
    expect((client.requests[1].messages[2].content[0] as { text: string }).text).toContain('item id "dup" is not allowed');
  });

  it("does not retry a refusal and names its category", async () => {
    const { client, runtime } = setup([{ text: "I can't help with that.", stopReason: "refusal", stopCategory: "general_harms" }]);
    const err = await call(runtime).catch((e) => e);
    expect(err).toBeInstanceOf(AiRefusalError);
    expect((err as AiRefusalError).category).toBe("general_harms");
    expect(client.requests).toHaveLength(1);
  });

  it("fails output that was cut off instead of trusting half a document", async () => {
    const { client, runtime } = setup([{ text: '{"items":[{"id":"a"', stopReason: "max_tokens" }]);
    await expect(call(runtime)).rejects.toThrow(/cut off/i);
    expect(client.requests).toHaveLength(1);
  });

  it("stops before a call that would take the task over its cost ceiling", async () => {
    const { client, runtime } = setup([{ text: "bad", usage: { inputTokens: 200_000, outputTokens: 1000 } }, { json: { items: [] } }], {
      ...ENV,
      AI_MAX_TASK_COST_USD: "0.05",
    });
    await expect(call(runtime)).rejects.toBeInstanceOf(AiBudgetError);
    expect(client.requests).toHaveLength(1);
  });

  it("refuses content that did not go through the data policy", async () => {
    const { client, runtime } = setup([{ json: { items: [] } }]);
    const forged = [{ type: "text", category: "BANKING", label: "forged", text: "account 123", chars: 11 }] as never;
    await expect(call(runtime, { prompt: forged })).rejects.toBeInstanceOf(PromptPolicyError);
    expect(client.requests).toHaveLength(0);
    expect(client.countRequests).toHaveLength(0);
  });

  it("instruction text cannot carry an identity number", () => {
    expect(() => trusted("Check director 8001015009087")).toThrow(PromptPolicyError);
  });
});

describe("prompt and response logging", () => {
  it("logs metadata, cost and sizes but never document text, model output or the key", async () => {
    const { runtime, logs } = setup([{ json: { items: [{ id: SENTINEL_REPLY, n: 1 }] }, usage: { inputTokens: 1000, outputTokens: 500 } }]);
    await call(runtime);
    const text = logs.text();
    expect(text).not.toContain("SENTINEL-DOCUMENT-TEXT");
    expect(text).not.toContain(SENTINEL_REPLY);
    expect(text).not.toContain("test-key-not-real");
    const rec = logs.records().find((r) => r.msg === "ai.call");
    expect(rec).toBeDefined();
    expect(rec).toMatchObject({ label: "test.extract", model: "model-mid", tier: "MID", agent: "tender_analyst", outcome: "ok", attempt: "initial" });
    // These keys survive log redaction: they are not named like secrets.
    expect(rec!.usage).toMatchObject({ in: 1000, out: 500 });
    expect(rec!.cost_usd).toBeCloseTo(0.007, 8);
    expect(rec!.prompt).toMatchObject({
      blocks: [expect.objectContaining({ label: "tender_document:d1", category: "TENDER_DOCUMENTS" }), expect.objectContaining({ label: "instruction" })],
    });
    expect(JSON.stringify(rec!.prompt)).toMatch(/"sha":"[0-9a-f]{12}"/);
  });

  it("does not log content when output validation fails", async () => {
    const { runtime, logs } = setup([{ json: { items: [{ id: SENTINEL_REPLY, n: -1 }] } }, { json: { items: [{ id: SENTINEL_REPLY, n: -2 }] } }]);
    await call(runtime).catch(() => undefined);
    expect(logs.text()).not.toContain(SENTINEL_REPLY);
    expect(logs.text()).not.toContain("SENTINEL-DOCUMENT-TEXT");
    const failed = logs.records().filter((r) => r.msg === "ai.call");
    expect(failed.map((r) => r.outcome)).toEqual(["invalid", "invalid"]);
    expect(failed[0].issues).toEqual(["items.0.n"]);
  });
});
