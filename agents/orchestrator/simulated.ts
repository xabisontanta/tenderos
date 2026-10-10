import type { AgentExecutor } from "@/agents/runtime/types";
import { NonRetryableError } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { hoursUntil } from "@/lib/domain/time";
import { SIMULATED_BID_PLAN } from "@/workflows/definitions/plan";
import { intakeOutputSchema, type IntakeOutput } from "./schema";

/** Tender Director intake: validates the record and lays out the plan. */
export const directorIntake: AgentExecutor<IntakeOutput> = {
  taskType: "director.intake",
  agent: "tender_director",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: intakeOutputSchema,
  async run(ctx) {
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");
    await simulateWork(ctx, ["Validating tender record", "Checking for duplicate workflows", "Planning workflow"]);

    const missing: string[] = [];
    if (!t.reference_number) missing.push("reference_number");
    if (!t.description) missing.push("description");
    if (t.estimated_value_zar == null) missing.push("estimated_value_zar");
    if (t.submission_method === "UNKNOWN") missing.push("submission_method");
    if (!t.source_url) missing.push("source_url");

    const hours = hoursUntil(t.closing_at, ctx.now) ?? 0;
    const warnings: string[] = [];
    if (hours <= 0) warnings.push("Closing date has passed");
    else if (hours < 72) warnings.push(`Closes in ${Math.round(hours)} hours`);

    return {
      output: {
        tender_id: t.id,
        hours_to_close: Math.round(hours * 10) / 10,
        plan: SIMULATED_BID_PLAN.map((s) => ({ step: s.key, agent: s.agent, title: s.title })),
        missing_fields: missing,
        warnings,
        simulated: ctx.workflow.isSimulation,
      },
      summary: `Planned ${SIMULATED_BID_PLAN.length} steps; ${missing.length} tender fields still missing`,
      events:
        hours > 0 && hours < 72
          ? [{ type: "DEADLINE_WARNING", severity: "WARNING", summary: `Tender closes in ${Math.round(hours)} hours` }]
          : [],
      cost: SIMULATED_COST,
    };
  },
};
