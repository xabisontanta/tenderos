import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { extractRecordRequirements } from "./logic";
import { analysisOutputSchema, type AnalysisOutput } from "./schema";

export const tenderAnalysis: AgentExecutor<AnalysisOutput> = {
  taskType: "analysis.extract",
  agent: "tender_analyst",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: analysisOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Reading tender record", "Extracting deadlines and briefings", "Recording gaps"]);
    const { requirements, gaps } = extractRecordRequirements(ctx.tender);
    const missing = requirements.filter((r) => r.status !== "EXTRACTED").length;
    return {
      output: { requirements, gaps, documents_analysed: 0, simulated: ctx.workflow.isSimulation },
      summary: `Extracted ${requirements.length} requirements from the tender record; ${missing + gaps.length} gaps flagged`,
      cost: SIMULATED_COST,
    };
  },
};
