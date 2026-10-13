import { tenderAnalysisReal } from "@/agents/analysis/real";
import { complianceCheck } from "@/agents/compliance/simulated";
import { pricingPrepareReal } from "@/agents/pricing/real";
import { proposalDraftReal } from "@/agents/proposal/real";
import { opportunityQualificationReal } from "@/agents/qualification/real";
import { qaReviewReal } from "@/agents/qa/real";
import type { AgentSlug } from "@/agents/registry";
import { AGENTS } from "@/agents/registry";
import type { AiClient } from "@/agents/runtime/ai/client";
import type { AiConfig } from "@/agents/runtime/ai/config";
import { createAiRuntime, type AiRuntime } from "@/agents/runtime/ai/runtime";
import type { AgentExecutor, AgentResult } from "@/agents/runtime/types";
import { createLogger } from "@/lib/log";
import { loadAiConfig } from "@/agents/runtime/ai/config";
import { FakeDocumentSource } from "../support/documents";
import { AI_ENV, makeCtx, tender } from "../support/context";
import { COMPANIES } from "./companies";
import type { EvalFixture } from "./types";

/** Config for the deterministic runs: invented model names and prices, never used for a real call. */
export const FAKE_CONFIG: AiConfig = loadAiConfig(AI_ENV);

function runtimeFor(fx: EvalFixture, client: AiClient, agent: AgentSlug, config: AiConfig): AiRuntime {
  const def = AGENTS.find((a) => a.slug === agent)!;
  return createAiRuntime({
    client,
    config,
    agent: { slug: agent, tier: def.modelTier, modelOverride: null },
    logger: createLogger({ service: "eval" }, "error"),
    documents: new FakeDocumentSource(fx.documents),
    signal: new AbortController().signal,
    webResearchEnabled: false,
  });
}

/** One agent step, run as the engine would run it for a real tender. */
async function step<T>(
  fx: EvalFixture,
  client: AiClient,
  config: AiConfig,
  executor: AgentExecutor<T>,
  stepKey: string,
  previousOutputs: Record<string, unknown>,
): Promise<AgentResult<T>> {
  const ctx = makeCtx({
    agent: executor.agent,
    taskType: executor.taskType,
    stepKey,
    tender: tender({ id: `eval-${fx.id}`, ...fx.tender }),
    company: fx.company ? COMPANIES[fx.company] : null,
    previousOutputs,
    ai: executor.ai ? runtimeFor(fx, client, executor.agent, config) : null,
  });
  const res = await executor.run(ctx);
  const parsed = executor.outputSchema.safeParse(res.output);
  if (!parsed.success)
    throw new Error(`${executor.taskType} output failed its schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { ...res, output: parsed.data };
}

/** Runs the Tender Analyst alone on a fixture. This is what `eval:live` scores against a real model. */
export function runAnalyst(fx: EvalFixture, client: AiClient, config: AiConfig = FAKE_CONFIG) {
  return step(fx, client, config, tenderAnalysisReal, "analysis", {});
}

export interface PipelineResult {
  analysis: Awaited<ReturnType<typeof runAnalyst>>;
  results: Record<string, AgentResult<unknown>>;
  /** Total spend across the AI steps, as the engine would record it. */
  costUsd: number;
}

/** Runs analysis, qualification, compliance, proposal, pricing and QA in order, each seeing the outputs before it. */
export async function runPipeline(fx: EvalFixture, client: AiClient, config: AiConfig = FAKE_CONFIG): Promise<PipelineResult> {
  const previous: Record<string, unknown> = {};
  const results: Record<string, AgentResult<unknown>> = {};
  const run = async <T>(executor: AgentExecutor<T>, key: string) => {
    const res = await step(fx, client, config, executor, key, previous);
    previous[key] = res.output;
    results[key] = res as AgentResult<unknown>;
    return res;
  };
  const analysis = await run(tenderAnalysisReal, "analysis");
  await run(opportunityQualificationReal, "qualification");
  await run(complianceCheck, "compliance");
  await run(proposalDraftReal, "proposal");
  await run(pricingPrepareReal, "pricing");
  await run(qaReviewReal, "qa");
  const costUsd = Object.values(results).reduce((n, r) => n + (r.cost?.costUsd ?? 0), 0);
  return { analysis, results, costUsd };
}
