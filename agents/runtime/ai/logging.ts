import { createHash } from "node:crypto";
import type { Logger } from "@/lib/log";
import type { AiMessage } from "./client";
import type { AiUsage } from "./pricing";

export interface PromptSummary {
  blocks: Array<{ label: string; category: string | null; chars: number }>;
  chars: number;
  /** Hash of the whole prompt: lets two calls be compared without storing what they said. */
  sha: string;
}

/** Shape and size of a prompt, never its content. */
export function describePrompt(system: string, messages: AiMessage[]): PromptSummary {
  const hash = createHash("sha256").update(system);
  const blocks: PromptSummary["blocks"] = [];
  let chars = system.length;
  for (const m of messages) {
    for (const b of m.content) {
      hash.update(m.role).update(b.type === "pdf" ? b.base64 : b.text);
      blocks.push({ label: b.label, category: b.category, chars: b.chars });
      chars += b.chars;
    }
  }
  return { blocks, chars, sha: hash.digest("hex").slice(0, 12) };
}

export interface AiCallLog {
  label: string;
  agent: string;
  model: string;
  tier: string;
  attempt: "initial" | "repair";
  outcome: "ok" | "invalid" | "refused" | "truncated" | "error";
  latencyMs: number;
  usage?: AiUsage;
  callCostUsd?: number;
  taskCostUsd: number;
  stopReason?: string | null;
  requestId?: string | null;
  prompt: PromptSummary;
  responseChars?: number;
  /** Paths of invalid fields, never their values. */
  issues?: string[];
  semanticIssues?: number;
  /** Error class and HTTP status only. */
  errorName?: string;
  errorStatus?: number | null;
}

/**
 * One structured line per model call: what ran, what it cost, how big the
 * prompt was, and whether the answer validated. Document text, model output
 * and personal data are never written; field names avoid the words lib/log
 * redacts (token, key and so on) so the numbers survive.
 */
export function logAiCall(logger: Logger, c: AiCallLog): void {
  const fields = {
    label: c.label,
    agent: c.agent,
    model: c.model,
    tier: c.tier,
    attempt: c.attempt,
    outcome: c.outcome,
    latency_ms: c.latencyMs,
    usage: c.usage
      ? {
          in: c.usage.inputTokens,
          out: c.usage.outputTokens,
          cache_read: c.usage.cacheReadTokens,
          cache_write: c.usage.cacheWriteTokens,
          searches: c.usage.webSearchRequests,
        }
      : undefined,
    cost_usd: c.callCostUsd,
    task_cost_usd: c.taskCostUsd,
    stop_reason: c.stopReason,
    request_id: c.requestId,
    prompt: c.prompt,
    response_chars: c.responseChars,
    issues: c.issues,
    semantic_issues: c.semanticIssues,
    error: c.errorName,
    http_status: c.errorStatus,
  };
  if (c.outcome === "ok") logger.info("ai.call", fields);
  else logger.warn("ai.call", fields);
}
