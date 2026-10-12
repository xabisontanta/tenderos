import Anthropic from "@anthropic-ai/sdk";
import { backoffMs } from "@/workflows/retry";
import { sleep } from "../simulation";
import type { AiBlock, AiClient, AiCountRequest, AiMessage, AiRequest, AiResponse } from "./client";
import type { AiConfig } from "./config";
import { AiOutputError, AiRequestError, AiTransientError } from "./errors";
import { assertApproved } from "./guardrails/data-policy";
import { scrubSensitiveIds } from "./guardrails/text";
import { ZERO_USAGE, addUsage, type AiUsage } from "./pricing";

/** The slice of the SDK this client uses, so tests can supply a stub. */
export interface AnthropicLike {
  messages: Pick<Anthropic["messages"], "stream" | "countTokens">;
}

export interface AnthropicClientOptions {
  /** Total tries per request (the first plus retries). */
  maxAttempts: number;
  baseMs?: number;
  maxMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const CACHE = { type: "ephemeral" } as const;
/** Anthropic allows four cache breakpoints per request; the system prompt takes one. */
const MAX_BLOCK_BREAKPOINTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_PAUSE_CONTINUATIONS = 4;

function toParams(messages: AiMessage[]): Anthropic.MessageParam[] {
  messages.forEach((m) => assertApproved(m.content));
  // Honour the last few cache flags; earlier ones are dropped rather than rejected by the API.
  const flagged: AiBlock[] = messages.flatMap((m) => m.content).filter((b) => b.cache);
  const cached = new Set<AiBlock>(flagged.slice(-MAX_BLOCK_BREAKPOINTS));
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): Anthropic.ContentBlockParam => {
      const cache = cached.has(b) ? { cache_control: CACHE } : {};
      return b.type === "pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b.base64 }, ...cache }
        : { type: "text", text: b.text, ...cache };
    }),
  }));
}

function outputConfig(req: Pick<AiRequest, "effort" | "outputSchema">): Anthropic.OutputConfig | undefined {
  const cfg: Anthropic.OutputConfig = {};
  if (req.effort) cfg.effort = req.effort;
  if (req.outputSchema) cfg.format = { type: "json_schema", schema: req.outputSchema };
  return Object.keys(cfg).length ? cfg : undefined;
}

type Verdict =
  { kind: "retry"; status: number | null; retryAfterMs: number | null } | { kind: "fatal"; status: number | null } | { kind: "abort" } | { kind: "unknown" };

function judge(err: unknown): Verdict {
  if (err instanceof Anthropic.APIUserAbortError) return { kind: "abort" };
  if (err instanceof Anthropic.APIConnectionError) return { kind: "retry", status: null, retryAfterMs: null };
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? null;
    if (status !== null && (status === 408 || status === 409 || status === 429 || status >= 500)) {
      const header = err.headers?.get?.("retry-after");
      const seconds = header ? Number(header) : Number.NaN;
      return { kind: "retry", status, retryAfterMs: Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null };
    }
    return { kind: "fatal", status };
  }
  return { kind: "unknown" };
}

function requestId(err: unknown): string | null {
  return err instanceof Anthropic.APIError ? (err.requestID ?? null) : null;
}

export class AnthropicAiClient implements AiClient {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(
    readonly sdk: AnthropicLike,
    private readonly opts: AnthropicClientOptions,
  ) {
    this.sleep = opts.sleep ?? sleep;
    this.random = opts.random ?? Math.random;
  }

  /** Retries 429, 5xx (including 529 overloaded), 408/409 and connection failures with exponential backoff and jitter. Other 4xx fail at once. */
  private async withRetries<T>(op: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (err) {
        const v = judge(err);
        if (v.kind === "unknown") throw err;
        if (v.kind === "abort") throw signal?.reason ?? err;
        if (signal?.aborted) throw signal.reason;
        if (v.kind === "fatal") {
          const detail = err instanceof Error ? scrubSensitiveIds(err.message).slice(0, 200) : "";
          throw new AiRequestError(
            `Anthropic rejected the request (HTTP ${v.status}${err instanceof Anthropic.APIError && err.type ? `, ${err.type}` : ""})${detail ? `: ${detail}` : ""}`,
            v.status,
            requestId(err),
          );
        }
        if (attempt >= this.opts.maxAttempts) {
          throw new AiTransientError(
            `Anthropic was unavailable after ${attempt} attempts${v.status ? ` (HTTP ${v.status})` : " (connection failed)"}`,
            v.status,
            requestId(err),
          );
        }
        const backoff = backoffMs(attempt - 1, { baseMs: this.opts.baseMs ?? 1000, maxMs: this.opts.maxMs ?? 30_000, jitter: 0.3, random: this.random });
        await this.sleep(Math.min(Math.max(backoff, v.retryAfterMs ?? 0), MAX_RETRY_AFTER_MS), signal);
      }
    }
  }

  async countTokens(req: AiCountRequest): Promise<number> {
    const messages = toParams(req.messages);
    const config = outputConfig({ effort: null, outputSchema: req.outputSchema });
    const res = await this.withRetries(
      () =>
        this.sdk.messages.countTokens(
          { model: req.model, system: [{ type: "text", text: req.system }], messages, ...(config ? { output_config: config } : {}) },
          { signal: req.signal, timeout: req.timeoutMs },
        ),
      req.signal,
    );
    return res.input_tokens;
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const messages = toParams(req.messages);
    const config = outputConfig(req);
    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: CACHE }],
      messages,
      ...(config ? { output_config: config } : {}),
      ...(req.webSearch
        ? {
            tools: [
              {
                type: "web_search_20260209" as const,
                name: "web_search" as const,
                max_uses: req.webSearch.maxUses,
                ...(req.webSearch.allowedDomains ? { allowed_domains: req.webSearch.allowedDomains } : {}),
              },
            ],
          }
        : {}),
    };

    let usage: AiUsage = ZERO_USAGE;
    let text = "";
    const sources = new Map<string, string>();
    let last: Anthropic.Message | null = null;

    for (let turn = 0; turn <= MAX_PAUSE_CONTINUATIONS; turn++) {
      // Streaming keeps long structured answers from hitting HTTP timeouts.
      const msg = await this.withRetries(() => this.sdk.messages.stream(params, { signal: req.signal, timeout: req.timeoutMs }).finalMessage(), req.signal);
      last = msg;
      usage = addUsage(usage, toUsage(msg.usage));
      for (const block of msg.content) {
        if (block.type === "text") {
          text += block.text;
          for (const c of block.citations ?? [])
            if (c.type === "web_search_result_location" && c.url && !sources.has(c.url)) sources.set(c.url, c.title ?? c.url);
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result" && !sources.has(r.url)) sources.set(r.url, r.title ?? r.url);
        }
      }
      if (msg.stop_reason !== "pause_turn") break;
      if (turn === MAX_PAUSE_CONTINUATIONS) {
        throw new AiOutputError(`The web research turn was still paused after ${MAX_PAUSE_CONTINUATIONS} continuations and was stopped`);
      }
      // The server paused its search loop; send the turn back unchanged and it resumes.
      params.messages = [...params.messages, { role: "assistant", content: msg.content as unknown as Anthropic.ContentBlockParam[] }];
    }

    const msg = last!;
    return {
      text,
      stopReason: msg.stop_reason,
      stopCategory: msg.stop_details?.category ?? null,
      usage,
      model: msg.model,
      requestId: (msg as unknown as { _request_id?: string | null })._request_id ?? null,
      sources: [...sources].map(([url, title]) => ({ url, title })),
    };
  }
}

function toUsage(u: Anthropic.Usage): AiUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * The production client. The SDK's own retries are switched off so that the
 * retry policy here (backoff with jitter, retry-after, abort-aware) is the
 * only one and every attempt is visible.
 */
export function createAnthropicClient(config: AiConfig, sdk?: AnthropicLike): AnthropicAiClient {
  return new AnthropicAiClient(sdk ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs }), { maxAttempts: config.maxAttempts });
}
