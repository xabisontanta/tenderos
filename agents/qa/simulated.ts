import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { reviewBid } from "./logic";
import { qaOutputSchema, type QaOutput } from "./schema";

export const qaReview: AgentExecutor<QaOutput> = {
  taskType: "qa.review",
  agent: "quality_assurance",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: qaOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Checking deadline and eligibility", "Reviewing documents and sections", "Reviewing pricing"]);
    const result = reviewBid(ctx.tender, ctx.previousOutputs, ctx.now);
    return {
      output: { ...result, simulated: ctx.workflow.isSimulation },
      summary:
        result.verdict === "FAIL"
          ? `QA failed: ${result.open_issues.length} problems`
          : result.verdict === "CONDITIONAL"
            ? `QA passed with ${result.open_issues.length} open issues for the approver`
            : "QA passed",
      events: [
        result.verdict === "FAIL"
          ? { type: "QA_FAIL", severity: "ERROR", summary: "Quality assurance failed", payload: { issues: result.open_issues } }
          : { type: "QA_PASS", summary: result.verdict === "PASS" ? "Quality assurance passed" : "QA passed with open issues", payload: { verdict: result.verdict, issues: result.open_issues } },
      ],
      cost: SIMULATED_COST,
    };
  },
};
