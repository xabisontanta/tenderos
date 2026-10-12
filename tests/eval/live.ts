import { createAnthropicClient } from "@/agents/runtime/ai/anthropic";
import { AiNotConfiguredError, loadAiConfig, resolveModel } from "@/agents/runtime/ai/config";
import { AGENTS } from "@/agents/registry";
import { FIXTURES } from "./fixtures";
import { formatReport, type ReportRow } from "./report";
import { runAnalyst, runPipeline } from "./run";
import { scoreAnalysis } from "./score";

type Env = Record<string, string | undefined>;

export interface LiveResult {
  skipped: boolean;
  exitCode: number;
  rows: ReportRow[];
}

/**
 * The opt-in live evaluation: runs the labelled fixtures through the real
 * Anthropic API and scores the Tender Analyst's output against the labels.
 * It does nothing, and costs nothing, unless ANTHROPIC_API_KEY is set.
 *
 * Environment: the usual AI_MODEL_* and AI_PRICE_* settings, plus
 * EVAL_FIXTURES (comma-separated ids; default all), EVAL_MAX_USD (stop after
 * this much spend; default 5), EVAL_MIN_RECALL (default 0.8), EVAL_PIPELINE=true
 * (run all five AI steps, not only the analyst) and EVAL_STRICT=true (exit 1
 * when a fixture fails).
 */
export async function runLive(env: Env, log: (line: string) => void): Promise<LiveResult> {
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    log("eval:live skipped: ANTHROPIC_API_KEY is not set. Nothing was sent and nothing was spent.");
    return { skipped: true, exitCode: 0, rows: [] };
  }
  let config;
  try {
    config = loadAiConfig(env);
    // Fail before the first paid call if the analyst's own model or price is missing.
    resolveModel(config, { agentTier: AGENTS.find((a) => a.slug === "tender_analyst")!.modelTier });
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      log(`eval:live cannot run: ${err.message}`);
      return { skipped: false, exitCode: 2, rows: [] };
    }
    throw err;
  }

  const wanted = env.EVAL_FIXTURES?.split(",").map((s) => s.trim()).filter(Boolean);
  const fixtures = wanted?.length ? FIXTURES.filter((f) => wanted.includes(f.id)) : FIXTURES;
  const maxUsd = Number(env.EVAL_MAX_USD ?? 5);
  const minRecall = Number(env.EVAL_MIN_RECALL ?? 0.8);
  const pipeline = env.EVAL_PIPELINE?.toLowerCase() === "true";
  const client = createAnthropicClient(config);

  log(`eval:live running ${fixtures.length} fixture(s) against the live API (${pipeline ? "all AI steps" : "Tender Analyst only"}), spend limit $${maxUsd}`);
  const rows: ReportRow[] = [];
  let spent = 0;
  for (const fx of fixtures) {
    const base = { fixtureId: fx.id, title: fx.title, tags: fx.tags, inputTokens: 0, outputTokens: 0 };
    if (spent >= maxUsd) {
      rows.push({ ...base, score: null, error: `skipped: the EVAL_MAX_USD limit of $${maxUsd} was reached`, costUsd: 0, ms: 0 });
      continue;
    }
    const started = Date.now();
    try {
      const run = pipeline ? await runPipeline(fx, client, config) : null;
      const analysis = run ? run.analysis : await runAnalyst(fx, client, config);
      const results = run ? Object.values(run.results) : [analysis];
      const cost = results.reduce((n, r) => n + (r.cost?.costUsd ?? 0), 0);
      spent += cost;
      rows.push({
        ...base,
        score: scoreAnalysis(fx, analysis.output, { minRecall }),
        error: null,
        costUsd: cost,
        inputTokens: results.reduce((n, r) => n + (r.cost?.inputTokens ?? 0), 0),
        outputTokens: results.reduce((n, r) => n + (r.cost?.outputTokens ?? 0), 0),
        ms: Date.now() - started,
      });
    } catch (err) {
      rows.push({ ...base, score: null, error: `${(err as Error).name}: ${(err as Error).message}`.slice(0, 300), costUsd: 0, ms: Date.now() - started });
    }
  }
  log("");
  log(formatReport(rows, { model: config.models.MID ?? "unset", minRecall }));
  const failed = rows.some((r) => r.error || !r.score?.passed);
  return { skipped: false, exitCode: failed && env.EVAL_STRICT?.toLowerCase() === "true" ? 1 : 0, rows };
}
