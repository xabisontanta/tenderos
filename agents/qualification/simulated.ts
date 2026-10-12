import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { assessQualification, companyFitInputs } from "./logic";
import { qualificationOutputSchema, type QualificationOutput } from "./schema";

export const opportunityQualification: AgentExecutor<QualificationOutput> = {
  taskType: "qualification.assess",
  agent: "opportunity_qualification",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["COMPANY_PROFILE", "COMPANY_CAPABILITIES"],
  outputSchema: qualificationOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Checking hard disqualifiers", "Assessing feasibility", "Compiling evidence"]);
    // Without a company profile the capability factors stay unconfirmed.
    const result = assessQualification(ctx.tender, ctx.now, companyFitInputs(ctx.company));
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
