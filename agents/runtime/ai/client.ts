import type { Effort } from "./config";
import type { ApprovedBlock, TrustedBlock } from "./guardrails/data-policy";
import type { AiUsage } from "./pricing";

/** Content the client will send. Both kinds can only be made by the data policy module. */
export type AiBlock = ApprovedBlock | TrustedBlock;

export interface AiMessage {
  role: "user" | "assistant";
  content: AiBlock[];
}

export interface AiRequest {
  /** Names the call in logs and test scripts. Never sent to the provider. */
  label: string;
  model: string;
  effort: Effort | null;
  /** Stable role prompt. Marked for prompt caching by the client. */
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  /** JSON Schema for structured output. */
  outputSchema?: Record<string, unknown>;
  /** Server-side web search (Anthropic web_search tool). */
  webSearch?: { maxUses: number; allowedDomains?: string[] };
  timeoutMs: number;
  signal?: AbortSignal;
}

export type AiCountRequest = Pick<AiRequest, "label" | "model" | "system" | "messages" | "outputSchema" | "timeoutMs" | "signal">;

export interface AiResponse {
  /** All text the model returned (for structured output: the JSON document). */
  text: string;
  stopReason: string | null;
  /** The category when the model declined (stop reason "refusal"). */
  stopCategory: string | null;
  usage: AiUsage;
  model: string;
  requestId: string | null;
  /** Pages the web search tool read, with URLs. */
  sources: Array<{ url: string; title: string }>;
}

/** The only door to a model. Production uses AnthropicAiClient; tests and the evaluation runner inject a fake. */
export interface AiClient {
  complete(req: AiRequest): Promise<AiResponse>;
  countTokens(req: AiCountRequest): Promise<number>;
}
