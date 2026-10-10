import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { evaluateCompliance, isComplete } from "./logic";
import { complianceOutputSchema, type ComplianceOutput } from "./schema";

export const complianceCheck: AgentExecutor<ComplianceOutput> = {
  taskType: "compliance.check",
  agent: "compliance",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: complianceOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Building returnables checklist", "Checking vault metadata", "Checking expiry dates"]);
    // The document vault arrives in Phase 5. Until then every item is reported missing.
    const items = evaluateCompliance(ctx.tender, null, ctx.now);
    const complete = isComplete(items);
    const missing = items.filter((i) => i.status !== "VALID").map((i) => i.label);
    const continued = !complete && ctx.workflow.isSimulation;
    return {
      output: { outcome: complete ? "COMPLETE" : "INCOMPLETE", items, missing, simulated: ctx.workflow.isSimulation, continued_in_simulation: continued },
      summary: complete ? "All mandatory compliance items valid" : `${missing.length} compliance items missing or unconfirmed`,
      events: [
        complete
          ? { type: "COMPLIANCE_PASS", summary: "Compliance checks passed" }
          : {
              type: "COMPLIANCE_FAIL",
              severity: "WARNING",
              summary: continued
                ? `${missing.length} items missing; simulation continues, a live run would stop here`
                : `${missing.length} compliance items missing`,
              payload: { missing },
            },
      ],
      cost: SIMULATED_COST,
    };
  },
};
