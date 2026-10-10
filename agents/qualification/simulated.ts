import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { assessQualification } from "./logic";
import { qualificationOutputSchema, type QualificationOutput } from "./schema";

export const opportunityQualification: AgentExecutor<QualificationOutput> = {
  taskType: "qualification.assess",
  agent: "opportunity_qualification",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: qualificationOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Checking hard disqualifiers", "Assessing feasibility", "Compiling evidence"]);
    // Company profile arrives in Phase 5; until then capability factors stay unconfirmed.
    const result = assessQualification(ctx.tender, ctx.now, null);
    const qualified = result.decision === "QUALIFIED";
    return {
      output: { ...result, simulated: ctx.workflow.isSimulation },
      summary: qualified
        ? `Qualified${result.confirmation_required ? " pending confirmation of company capability" : ""}`
        : `Rejected: ${result.hard_disqualifiers.join("; ")}`,
      events: [
        qualified
          ? { type: "TENDER_QUALIFIED", summary: "Tender passed qualification checks", payload: { fit_score: result.fit_score } }
          : { type: "TENDER_REJECTED", severity: "WARNING", summary: "Tender failed a hard disqualifier", payload: { reasons: result.hard_disqualifiers } },
      ],
      cost: SIMULATED_COST,
    };
  },
};
