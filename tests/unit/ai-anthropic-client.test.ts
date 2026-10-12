import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { DataCategory } from "@/agents/registry";
import { createAnthropicClient, AnthropicAiClient, type AnthropicLike } from "@/agents/runtime/ai/anthropic";
import type { AiRequest } from "@/agents/runtime/ai/client";
import { loadAiConfig } from "@/agents/runtime/ai/config";
import { AiRequestError, AiTransientError } from "@/agents/runtime/ai/errors";
import { buildPrompt, trusted } from "@/agents/runtime/ai/guardrails/data-policy";
import { NonRetryableError } from "@/agents/runtime/types";

const GRANTED = new Set<DataCategory>(["TENDER_DOCUMENTS"]);

const request = (over: Partial<AiRequest> = {}): AiRequest => ({
  label: "test",
  model: "model-mid",
  effort: null,
  system: "You are a test agent.",
  messages: [
    {
      role: "user",
      content: [
        ...buildPrompt([{ type: "text", category: "TENDER_DOCUMENTS", label: "doc", text: "Tender text.", cache: true }], GRANTED),
        trusted("Do the task."),
      ],
    },
  ],
  maxTokens: 4000,
  timeoutMs: 90_000,
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "model-mid",
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, server_tool_use: null },
  _request_id: "req_abc",
  ...over,
});

/** A request as the stub records it: plain JSON, read loosely by the assertions. */
type Recorded = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function stub(results: Array<unknown | Error>) {
  const streamCalls: Array<{ params: Recorded; opts: Recorded }> = [];
  const countCalls: Recorded[] = [];
  let i = 0;
  const sdk = {
    messages: {
      stream: (params: Recorded, opts: Recorded) => {
        streamCalls.push({ params: JSON.parse(JSON.stringify(params)), opts });
        return {
          finalMessage: async () => {
            const r = results[i++];
            if (r instanceof Error) throw r;
            return r;
          },
        };
      },
      countTokens: async (params: Recorded) => {
        countCalls.push(params);
        return { input_tokens: 321 };
      },
    },
  } as unknown as AnthropicLike;
  return { sdk, streamCalls, countCalls };
}

const apiError = (status: number, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "boom" } }, "boom", new Headers(headers));

function client(results: Array<unknown | Error>, over: { maxAttempts?: number } = {}) {
  const s = stub(results);
  const sleeps: number[] = [];
  const c = new AnthropicAiClient(s.sdk, {
    maxAttempts: over.maxAttempts ?? 3,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { c, sleeps, ...s };
}

describe("request shape", () => {
  it("streams a structured request with a cached system prompt and no sampling parameters", async () => {
    const { c, streamCalls } = client([message()]);
    const schema = { type: "object", properties: {}, additionalProperties: false };
    await c.complete(request({ outputSchema: schema, effort: "high" }));
    const { params, opts } = streamCalls[0];
    expect(params.model).toBe("model-mid");
    expect(params.max_tokens).toBe(4000);
    expect(params.system).toEqual([{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }]);
    expect(params.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema } });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tool_choice", "tools", "stream"]) expect(params, k).not.toHaveProperty(k);
    expect(opts.timeout).toBe(90_000);
  });

  it("marks cacheable blocks and leaves the task instruction uncached", async () => {
    const { c, streamCalls } = client([message()]);
    await c.complete(request());
    const content = streamCalls[0].params.messages[0].content;
    expect(content[0]).toEqual({ type: "text", text: "Tender text.", cache_control: { type: "ephemeral" } });
    expect(content[1]).toEqual({ type: "text", text: "Do the task." });
  });

  it("sends PDFs as base64 document blocks", async () => {
    const { c, streamCalls } = client([message()]);
    const pdf = buildPrompt([{ type: "pdf", category: "TENDER_DOCUMENTS", label: "pdf", base64: "JVBERi0xLjQ=" }], GRANTED);
    await c.complete(request({ messages: [{ role: "user", content: [...pdf, trusted("Read it.")] }] }));
    expect(streamCalls[0].params.messages[0].content[0]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" },
    });
  });

  it("omits output_config when nothing is configured", async () => {
    const { c, streamCalls } = client([message()]);
    await c.complete(request());
    expect(streamCalls[0].params).not.toHaveProperty("output_config");
  });

  it("declares the web search tool only when asked", async () => {
    const { c, streamCalls } = client([message()]);
    await c.complete(request({ webSearch: { maxUses: 3, allowedDomains: ["treasury.gov.za"] } }));
    expect(streamCalls[0].params.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_domains: ["treasury.gov.za"] }]);
  });

  it("refuses blocks that did not pass the data policy", async () => {
    const { c, streamCalls } = client([message()]);
    const forged = [{ type: "text", category: "BANKING", label: "x", text: "acct", chars: 4 }] as never;
    await expect(c.complete(request({ messages: [{ role: "user", content: forged }] }))).rejects.toThrow(/data policy/);
    expect(streamCalls).toHaveLength(0);
  });
});

describe("response mapping", () => {
  it("returns text, stop reason, request id and all four token classes", async () => {
    const { c } = client([message()]);
    const r = await c.complete(request());
    expect(r).toMatchObject({
      text: '{"ok":true}',
      stopReason: "end_turn",
      model: "model-mid",
      requestId: "req_abc",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, webSearchRequests: 0 },
    });
  });

  it("ignores thinking blocks and joins text blocks", async () => {
    const { c } = client([
      message({
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ]);
    expect((await c.complete(request())).text).toBe("ab");
  });

  it("reports the refusal category", async () => {
    const { c } = client([message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } })]);
    expect(await c.complete(request())).toMatchObject({ stopReason: "refusal", stopCategory: "cyber" });
  });

  it("counts tokens against the same model, system and messages", async () => {
    const { c, countCalls } = client([]);
    expect(await c.countTokens(request({ outputSchema: { type: "object" } }))).toBe(321);
    expect(countCalls[0]).toMatchObject({ model: "model-mid", system: [{ type: "text", text: "You are a test agent." }] });
    expect(countCalls[0].messages).toHaveLength(1);
  });
});

describe("retries with backoff and jitter", () => {
  it.each([429, 500, 502, 503, 529])("retries HTTP %i and then succeeds", async (status) => {
    const { c, streamCalls, sleeps } = client([apiError(status), apiError(status), message()]);
    expect((await c.complete(request())).text).toBe('{"ok":true}');
    expect(streamCalls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  it("retries connection failures and timeouts", async () => {
    const { c, streamCalls } = client([new Anthropic.APIConnectionError({ message: "down" }), new Anthropic.APIConnectionTimeoutError(), message()]);
    await c.complete(request());
    expect(streamCalls).toHaveLength(3);
  });

  it("honours retry-after", async () => {
    const { c, sleeps } = client([apiError(429, { "retry-after": "7" }), message()]);
    await c.complete(request());
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
  });

  it("applies jitter around the exponential delay", async () => {
    const s = stub([apiError(503), message()]);
    const delays: number[] = [];
    const lo = new AnthropicAiClient(s.sdk, { maxAttempts: 3, sleep: async (ms) => void delays.push(ms), random: () => 0 });
    await lo.complete(request());
    const s2 = stub([apiError(503), message()]);
    const hi = new AnthropicAiClient(s2.sdk, { maxAttempts: 3, sleep: async (ms) => void delays.push(ms), random: () => 1 });
    await hi.complete(request());
    expect(delays[0]).toBeLessThan(delays[1]);
  });

  it("gives up after the configured attempts with a retryable error for the task-level retry", async () => {
    const { c, streamCalls } = client([apiError(529), apiError(529), apiError(529), message()], { maxAttempts: 3 });
    const err = await c.complete(request()).catch((e) => e);
    expect(err).toBeInstanceOf(AiTransientError);
    expect(err).not.toBeInstanceOf(NonRetryableError);
    expect(streamCalls).toHaveLength(3);
  });

  it.each([400, 401, 403, 404, 413, 422])("does not retry HTTP %i and reports it as non-retryable", async (status) => {
    const { c, streamCalls } = client([apiError(status), message()]);
    const err = await c.complete(request()).catch((e) => e);
    expect(err).toBeInstanceOf(AiRequestError);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as AiRequestError).status).toBe(status);
    expect(streamCalls).toHaveLength(1);
  });

  it("stops retrying when the task's signal aborts", async () => {
    const controller = new AbortController();
    const s = stub([apiError(503), message()]);
    const c = new AnthropicAiClient(s.sdk, {
      maxAttempts: 3,
      sleep: async () => {
        controller.abort(new Error("Timed out after 300s"));
        throw controller.signal.reason;
      },
      random: () => 0.5,
    });
    await expect(c.complete(request({ signal: controller.signal }))).rejects.toThrow("Timed out after 300s");
    expect(s.streamCalls).toHaveLength(1);
  });

  it("surfaces the abort reason when the SDK reports a user abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Timed out after 300s"));
    const { c } = client([new Anthropic.APIUserAbortError()]);
    await expect(c.complete(request({ signal: controller.signal }))).rejects.toThrow("Timed out after 300s");
  });
});

describe("web search turns", () => {
  const searchBlocks = [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "s1",
      content: [
        { type: "web_search_result", url: "https://a.gov.za/page", title: "A", page_age: null, encrypted_content: "x" },
        { type: "web_search_result", url: "https://b.gov.za/page", title: "B", page_age: null, encrypted_content: "y" },
      ],
    },
  ];

  it("resumes a paused turn, adds up usage and returns deduplicated sources", async () => {
    const { c, streamCalls } = client([
      message({
        stop_reason: "pause_turn",
        content: [...searchBlocks],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
      }),
      message({
        content: [
          {
            type: "text",
            text: "Found it.",
            citations: [{ type: "web_search_result_location", url: "https://a.gov.za/page", title: "A", cited_text: "x", encrypted_index: "e" }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
      }),
    ]);
    const r = await c.complete(request({ webSearch: { maxUses: 2 } }));
    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[1].params.messages.at(-1).role).toBe("assistant");
    expect(r.text).toBe("Found it.");
    expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 12, webSearchRequests: 2 });
    expect(r.sources.map((s) => s.url).sort()).toEqual(["https://a.gov.za/page", "https://b.gov.za/page"]);
  });

  it("does not loop forever on a model that keeps pausing", async () => {
    const paused = message({ stop_reason: "pause_turn", content: [...searchBlocks] });
    const { c, streamCalls } = client([paused, paused, paused, paused, paused, paused, paused]);
    await expect(c.complete(request({ webSearch: { maxUses: 2 } }))).rejects.toThrow(/paused/i);
    expect(streamCalls.length).toBeLessThanOrEqual(5);
  });
});

describe("construction", () => {
  const config = loadAiConfig({ ANTHROPIC_API_KEY: "test-key-not-real", AI_MODEL_MID: "m", AI_PRICE_MID: "2/10" });

  it("disables the SDK's own retries so ours are the only ones, and sets the timeout", () => {
    const c = createAnthropicClient(config);
    const sdk = c.sdk as unknown as Anthropic;
    expect(sdk.maxRetries).toBe(0);
    expect(sdk.timeout).toBe(config.timeoutMs);
  });

  it("never puts the key in an error message", async () => {
    const { c } = client([apiError(401)]);
    const err = await c.complete(request()).catch((e) => e);
    expect(String((err as Error).message)).not.toContain("test-key-not-real");
  });

  it("does not sleep when the first attempt succeeds", async () => {
    const { c, sleeps } = client([message()]);
    await c.complete(request());
    expect(sleeps).toEqual([]);
  });
});
