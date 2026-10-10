import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { documentEvidence, evaluateCompliance, isComplete, profileEvidence } from "./logic";
import { complianceOutputSchema, type ComplianceOutput } from "./schema";

export const complianceCheck: AgentExecutor<ComplianceOutput> = {
  taskType: "compliance.check",
  agent: "compliance",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["COMPANY_PROFILE", "TAX", "BBBEE", "CERTIFICATIONS"],
  outputSchema: complianceOutputSchema,
  async run(ctx) {
    if (!ctx.tender) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Building returnables checklist", "Checking uploaded documents and company profile", "Checking expiry dates"]);
    // Evidence comes from uploaded documents first, then the company profile.
    // With neither, every item is reported missing.
    const profile = profileEvidence(ctx.company);
    const docs = documentEvidence(ctx.documents);
    const vault = profile === null && docs.length === 0 ? null : [...docs, ...(profile ?? [])];
    const items = evaluateCompliance(ctx.tender, vault, ctx.now);
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
