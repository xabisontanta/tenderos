import { createLogger } from "@/lib/log";
import type { AgentSlug, DataCategory } from "@/agents/registry";
import { AGENTS } from "@/agents/registry";
import { createToolGate, type ToolRefusal } from "@/agents/runtime/tool-access";
import type { AgentContext, CompanyDocumentMeta, CompanyProfile, TenderSnapshot } from "@/agents/runtime/types";
import type { AiClient } from "@/agents/runtime/ai/client";
import { loadAiConfig } from "@/agents/runtime/ai/config";
import { NO_DOCUMENTS, type DocumentSource } from "@/agents/runtime/ai/documents";
import { createAiRuntime, type AiRuntime } from "@/agents/runtime/ai/runtime";

export const NOW = new Date("2026-10-10T10:00:00Z");
export const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

export const AI_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: "test-key-not-real",
  AI_MODEL_LOW: "model-low",
  AI_MODEL_MID: "model-mid",
  AI_MODEL_HIGH: "model-high",
  AI_PRICE_LOW: "0.1/0.5",
  AI_PRICE_MID: "2/10",
  AI_PRICE_HIGH: "4/20/0.2/5",
};

export const tender = (o: Partial<TenderSnapshot> = {}): TenderSnapshot => ({
  id: "00000000-0000-0000-0000-000000000001",
  reference_number: "DWS/2026/014",
  title: "Rehabilitation of access roads",
  issuing_organisation: "Test Municipality",
  description: "Rehabilitation of 4 km of access roads.",
  province: "GAUTENG",
  sector: "Construction",
  estimated_value_zar: null,
  published_at: inDays(-7),
  closing_at: "2026-10-28T09:00:00.000Z", // 11:00 SAST
  briefing_at: null,
  briefing_compulsory: false,
  briefing_location: null,
  questions_deadline_at: null,
  submission_method: "ELECTRONIC_PORTAL",
  submission_destination: null,
  source_url: null,
  is_simulation: false,
  ...o,
});

/** A runtime wired to the given client with test config; the logger only shows errors. */
export function makeAi(
  client: AiClient,
  over: {
    agent?: AgentSlug;
    documents?: DocumentSource;
    env?: Record<string, string | undefined>;
    webResearch?: boolean;
    signal?: AbortSignal;
    logger?: ReturnType<typeof createLogger>;
  } = {},
): AiRuntime {
  const slug = over.agent ?? "tender_analyst";
  const def = AGENTS.find((a) => a.slug === slug)!;
  return createAiRuntime({
    client,
    config: loadAiConfig(over.env ?? AI_ENV),
    agent: { slug, tier: def.modelTier, modelOverride: null },
    logger: over.logger ?? createLogger({ service: "test" }, "error"),
    documents: over.documents ?? NO_DOCUMENTS,
    signal: over.signal ?? new AbortController().signal,
    webResearchEnabled: over.webResearch ?? false,
  });
}

export interface CtxOptions {
  agent: AgentSlug;
  taskType: string;
  stepKey: string;
  ai?: AiRuntime | null;
  tender?: TenderSnapshot | null;
  company?: CompanyProfile | null;
  documents?: CompanyDocumentMeta[];
  previousOutputs?: Record<string, unknown>;
  granted?: DataCategory[];
  /** Tools the agent's stored row allows. Defaults to the registry list. */
  allowedTools?: string[];
  refusals?: ToolRefusal[];
}

/** An AgentContext for a real (non-simulated) run, with grants defaulting to the agent's registry categories. */
export function makeCtx(o: CtxOptions): AgentContext {
  const def = AGENTS.find((a) => a.slug === o.agent)!;
  const refusals = o.refusals ?? [];
  return {
    agentSlug: o.agent,
    task: { id: "task-1", type: o.taskType, stepKey: o.stepKey, input: {}, retryCount: 0 },
    workflow: { runId: "run-1", correlationId: "corr-1", isSimulation: false, options: {} },
    tender: o.tender === undefined ? tender() : o.tender,
    company: o.company ?? null,
    documents: o.documents ?? [],
    previousOutputs: o.previousOutputs ?? {},
    granted: new Set(o.granted ?? def.dataCategories),
    now: NOW,
    signal: new AbortController().signal,
    tools: createToolGate({ agent: o.agent, allowedTools: o.allowedTools ?? def.allowedTools, onRefused: (r) => void refusals.push(r) }),
    ai: o.ai ?? null,
    simulationStepMs: 0,
    progress: async () => undefined,
  };
}
