import type { z } from "zod";
import type { RoutingInput } from "../model-routing";
import type { AiMessage, AiResponse } from "./client";
import { AiInputTooLargeError, AiOutputError, AiRefusalError } from "./errors";
import { assertApproved, trusted, type ApprovedBlock } from "./guardrails/data-policy";
import { describePrompt, logAiCall } from "./logging";
import type { AiRuntime } from "./runtime";
import { assertWithinStructuredLimits, toStructuredSchema } from "./schema";

export interface StructuredCall<T> {
  runtime: AiRuntime;
  /** Names the call in logs, e.g. "analysis.extract". */
  label: string;
  routing?: Pick<RoutingInput, "highValue" | "complex">;
  /** Stable role prompt (see buildSystemPrompt). */
  system: string;
  /** Data for the model, built with buildPrompt. Mark large stable blocks `cache: true`. */
  prompt: ApprovedBlock[];
  /** The task, in our own words. Placed last so everything before it can be cached. */
  instruction: string;
  schema: z.ZodType<T>;
  /** Meaning checks beyond the schema. Problems found are sent back for the single repair attempt. */
  validate?: (value: T) => string[];
  maxTokens?: number;
}

const MAX_ISSUES_SENT = 10;

function pathOf(issue: { path: PropertyKey[] }): string {
  return issue.path.length ? issue.path.map(String).join(".") : "$";
}

/**
 * Asks the model for JSON that matches a zod schema (structured outputs),
 * validates it, and allows exactly one repair attempt that replays the
 * exchange and lists what was wrong. After that it fails without retrying
 * (AiOutputError is non-retryable): the same prompt will not suddenly work.
 * Spend from every call, including failed ones, stays on `runtime.meter`.
 */
export async function generateStructured<T>(call: StructuredCall<T>): Promise<T> {
  const { runtime } = call;
  const { config } = runtime;
  const model = runtime.resolve(call.routing);
  const outputSchema = toStructuredSchema(call.schema);
  assertWithinStructuredLimits(outputSchema, call.label);
  assertApproved(call.prompt);

  const messages: AiMessage[] = [{ role: "user", content: [...call.prompt, trusted(call.instruction, "instruction")] }];
  const maxTokens = Math.min(call.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens);
  let lastIssues: string[] = [];

  for (const attempt of ["initial", "repair"] as const) {
    const prompt = describePrompt(call.system, messages);

    // Count first: refuse oversized prompts and calls the task budget cannot cover, before paying for them.
    const tokens = await runtime.client.countTokens({
      label: call.label,
      model: model.model,
      system: call.system,
      messages,
      outputSchema,
      timeoutMs: config.timeoutMs,
      signal: runtime.signal,
    });
    if (tokens > config.maxInputTokens) {
      throw new AiInputTooLargeError(
        `The prompt is ${tokens} tokens, over the limit of ${config.maxInputTokens} (AI_MAX_INPUT_TOKENS); the material must be split`,
        tokens,
      );
    }
    runtime.meter.assertCanSpend((tokens / 1_000_000) * model.price.inputPerMillion);

    const started = Date.now();
    let res: AiResponse;
    try {
      res = await runtime.client.complete({
        label: call.label,
        model: model.model,
        effort: model.effort,
        system: call.system,
        messages,
        maxTokens,
        outputSchema,
        timeoutMs: config.timeoutMs,
        signal: runtime.signal,
      });
    } catch (err) {
      logAiCall(runtime.logger, {
        label: call.label,
        agent: runtime.agent.slug,
        model: model.model,
        tier: model.tier,
        attempt,
        outcome: "error",
        latencyMs: Date.now() - started,
        taskCostUsd: runtime.meter.costUsd,
        prompt,
        errorName: (err as Error).name,
        errorStatus: (err as { status?: number | null }).status ?? null,
      });
      throw err;
    }

    const callCost = runtime.meter.record(model, res.usage);
    const base = {
      label: call.label,
      agent: runtime.agent.slug,
      model: model.model,
      tier: model.tier,
      attempt,
      latencyMs: Date.now() - started,
      usage: res.usage,
      callCostUsd: callCost,
      taskCostUsd: runtime.meter.costUsd,
      stopReason: res.stopReason,
      requestId: res.requestId,
      prompt,
      responseChars: res.text.length,
    };

    if (res.stopReason === "refusal") {
      logAiCall(runtime.logger, { ...base, outcome: "refused" });
      throw new AiRefusalError(res.stopCategory);
    }
    if (res.stopReason === "max_tokens") {
      logAiCall(runtime.logger, { ...base, outcome: "truncated" });
      throw new AiOutputError("The model's output was cut off at the token limit, so it was not used; the task needs a person or a smaller input");
    }

    const check = parseAndValidate(res.text, call);
    if (check.ok) {
      logAiCall(runtime.logger, { ...base, outcome: "ok" });
      return check.value;
    }
    lastIssues = check.paths;
    logAiCall(runtime.logger, { ...base, outcome: "invalid", issues: check.paths.slice(0, MAX_ISSUES_SENT), semanticIssues: check.semantic.length });
    if (attempt === "repair") break;

    messages.push(
      { role: "assistant", content: [trusted(res.text, "model_reply")] },
      {
        role: "user",
        content: [
          trusted(
            `Your previous reply did not pass validation. Problems:\n${[...check.messages, ...check.semantic]
              .slice(0, MAX_ISSUES_SENT)
              .map((m) => `- ${m}`)
              .join(
                "\n",
              )}\nReturn the complete corrected JSON document again. Fix only what is listed, and do not add anything the supplied material does not support.`,
            "repair_request",
          ),
        ],
      },
    );
  }

  throw new AiOutputError(
    `The model's output failed validation after one repair attempt (${lastIssues.slice(0, MAX_ISSUES_SENT).join(", ") || "no detail"}); a person needs to look at this task`,
  );
}

type Check<T> = { ok: true; value: T } | { ok: false; paths: string[]; messages: string[]; semantic: string[] };

function parseAndValidate<T>(text: string, call: StructuredCall<T>): Check<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, paths: ["$"], messages: ["$: the reply was not a single valid JSON document"], semantic: [] };
  }
  const parsed = call.schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      paths: parsed.error.issues.map(pathOf),
      messages: parsed.error.issues.map((i) => `${pathOf(i)}: ${i.message}`),
      semantic: [],
    };
  }
  const semantic = call.validate?.(parsed.data) ?? [];
  if (semantic.length) return { ok: false, paths: ["semantic"], messages: [], semantic };
  return { ok: true, value: parsed.data };
}
