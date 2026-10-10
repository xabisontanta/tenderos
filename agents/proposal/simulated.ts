import type { AgentExecutor } from "@/agents/runtime/types";
import { SIMULATED_COST, simulateWork } from "@/agents/runtime/simulation";
import { proposalOutputSchema, type ProposalOutput } from "./schema";

const SECTIONS: Array<{ key: string; title: string; needs: string[] }> = [
  { key: "executive_summary", title: "Executive summary", needs: ["Company overview", "Confirmed scope understanding"] },
  { key: "methodology", title: "Methodology and approach", needs: ["Company delivery methodology"] },
  { key: "delivery_schedule", title: "Delivery schedule", needs: ["Delivery capacity", "Contract duration from tender documents"] },
  { key: "staffing", title: "Key personnel", needs: ["Verified staff list and qualifications"] },
  { key: "experience", title: "Relevant experience and references", needs: ["Verified project references"] },
  { key: "quality", title: "Quality management", needs: ["Quality certifications or procedures"] },
];

/**
 * Proposal Writer (simulation): builds the section outline. Without a company
 * profile and references there is nothing verified to write, so every section
 * is flagged MISSING_INFORMATION with the facts it needs.
 */
export const proposalDraft: AgentExecutor<ProposalOutput> = {
  taskType: "proposal.draft",
  agent: "proposal_writer",
  requires: ["PUBLIC_TENDER_DATA"],
  outputSchema: proposalOutputSchema,
  async run(ctx) {
    await simulateWork(ctx, ["Mapping requirements to sections", "Checking verified company facts", "Flagging gaps"]);
    const sections = SECTIONS.map((s) => ({ ...s, status: "MISSING_INFORMATION" as const, content: null }));
    return {
      output: { sections, open_items: sections.length, simulated: ctx.workflow.isSimulation },
      summary: `Outlined ${sections.length} proposal sections; all need verified company information`,
      events: [{ type: "PROPOSAL_GENERATED", summary: "Proposal outline generated (no content invented)", payload: { open_items: sections.length } }],
      cost: SIMULATED_COST,
    };
  },
};
