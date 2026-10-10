import type { AgentExecutor } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { SA_VAT_RATE, subtotal } from "./logic";
import { pricingOutputSchema, type PricingOutput } from "./schema";

/** Pricing Agent (simulation): never produces prices without quotes or rate cards. */
export const pricingPrepare: AgentExecutor<PricingOutput> = {
  taskType: "pricing.prepare",
  agent: "pricing",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: pricingOutputSchema,
  async run(ctx) {
    await simulateWork(ctx, ["Reading pricing schedule format", "Looking up quotations", "Structuring schedule"]);
    const lines: PricingOutput["lines"] = [];
    return {
      output: {
        currency: "ZAR",
        vat_rate: SA_VAT_RATE,
        lines,
        subtotal_zar: lines.length ? subtotal(lines) : null,
        status: "REQUIRES_CONFIRMATION",
        notes: ["No supplier quotations or pricing rules on file; no prices were generated", "Final pricing requires human approval"],
        requires_human_approval: true,
        simulated: ctx.workflow.isSimulation,
      },
      summary: "Pricing schedule structured; figures require quotations and human input",
      events: [{ type: "PRICING_READY", summary: "Pricing structure ready (no figures without quotations)" }],
      cost: SIMULATED_COST,
    };
  },
};
