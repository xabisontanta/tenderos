import type { AgentContext, CostRecord } from "./types";

/** Zero-cost marker attached to simulated executions so spend reports stay truthful. */
export const SIMULATED_COST: CostRecord = {
  provider: "simulation",
  model: "none",
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  isSimulated: true,
};

export class InjectedFailureError extends Error {
  constructor(step: string, attempt: number) {
    super(`Injected simulation failure at step "${step}" (attempt ${attempt + 1})`);
    this.name = "InjectedFailureError";
  }
}

/**
 * Simulated agents pace their work so state changes are observable, report
 * progress at checkpoints, and honour failure injection for failure-path tests.
 * Real tenders are not slowed down: the checkpoints are reported without waiting.
 */
export async function simulateWork(ctx: AgentContext, checkpoints: string[]): Promise<void> {
  const { fail_step, fail_times = 1 } = ctx.workflow.options;
  const perStep = checkpoints.length && ctx.workflow.isSimulation ? ctx.simulationStepMs / checkpoints.length : 0;
  for (let i = 0; i < checkpoints.length; i++) {
    await sleep(perStep, ctx.signal);
    if (fail_step === ctx.task.stepKey && ctx.task.retryCount < fail_times && i === Math.floor(checkpoints.length / 2)) {
      throw new InjectedFailureError(ctx.task.stepKey, ctx.task.retryCount);
    }
    await ctx.progress(Math.round(((i + 1) / (checkpoints.length + 1)) * 100), checkpoints[i]);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 && !signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}
