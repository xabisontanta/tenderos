import { analysisOutputSchema } from "@/agents/analysis/schema";
import { RULES_COST, requireAi } from "@/agents/runtime/ai/context";
import { companyFacts, factParts, hasCapabilityFacts, renderFacts } from "@/agents/runtime/ai/facts";
import { buildPrompt, type PromptPart } from "@/agents/runtime/ai/guardrails/data-policy";
import { wrapUntrusted } from "@/agents/runtime/ai/guardrails/text";
import { buildSystemPrompt } from "@/agents/runtime/ai/prompts";
import { renderRequirements, renderTenderRecord } from "@/agents/runtime/ai/render";
import { generateStructured } from "@/agents/runtime/ai/structured";
import { NonRetryableError, type AgentExecutor } from "@/agents/runtime/types";
import { PROPOSAL_SECTIONS, assembleProposal, validateProposal } from "./logic";
import { proposalModelSchema, proposalOutputSchema, type ProposalOutput } from "./schema";

const OUTLINE = PROPOSAL_SECTIONS.map((s) => `- ${s.key}: ${s.title}. A person would need: ${s.needs.join("; ")}`).join("\n");

const SYSTEM = buildSystemPrompt({
  role: "Proposal Writer",
  mission:
    "Draft sections of a tender response for a person to review and edit. You write only from the company facts and tender requirements you are given; where they do not support a section, you say what is missing instead of writing something plausible.",
  rules: [
    "Everything you write is a draft. A person checks every sentence before anything is submitted.",
    "Write only what the supplied company facts and tender requirements say. A fact is a line in brackets such as [fact:cidb_grade] or [doc:...]; a requirement is a line such as [doc-1].",
    "Every paragraph must cite the fact ids and/or requirement ids it rests on, exactly as written in the brackets. A paragraph about the company must cite a fact.",
    "Never invent projects, clients, references, staff, qualifications, years of experience, counts, turnover, equipment, certifications (such as ISO standards), methods, dates or prices. If the facts do not support a section, set its status to MISSING_INFORMATION, leave paragraphs empty, and list in needs what a person must supply.",
    "Do not describe a methodology, team, quality system or schedule unless the facts describe it. A generic plausible method is an invention.",
    "A section may be DRAFTED only when its paragraphs fully answer it; if parts are still missing, list them in needs.",
    "Plain prose paragraphs: no headings, no markdown, no placeholders such as [insert name].",
    `Fill in these outline sections, using exactly these keys:\n${OUTLINE}`,
  ],
});

/**
 * Proposal Writer (AI): drafts the outline sections from allow-listed company
 * facts and the analysed requirements. Text that cites nothing, cites
 * something that is not there, or states figures found in neither source is
 * rejected or removed; a section with nothing left stays MISSING_INFORMATION.
 * The result is flagged AI-generated and goes to a person.
 */
export const proposalDraftReal: AgentExecutor<ProposalOutput> = {
  taskType: "proposal.draft",
  agent: "proposal_writer",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["TENDER_DOCUMENTS", "COMPANY_PROFILE", "COMPANY_CAPABILITIES", "PROJECT_REFERENCES"],
  tools: ["company.capabilities.read", "company.references.read"],
  ai: true,
  outputSchema: proposalOutputSchema,
  async run(ctx) {
    const ai = requireAi(ctx);
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");

    await ctx.progress(15, "Reading verified company facts");
    const all = companyFacts(ctx.company, ctx.documents, ctx.granted, ctx.now);
    const capabilityFacts = await ctx.tools.run("company.capabilities.read", async () => all.filter((f) => f.category !== "PROJECT_REFERENCES"));
    const referenceFacts = await ctx.tools.run("company.references.read", async () => all.filter((f) => f.category === "PROJECT_REFERENCES"));
    const facts = [...capabilityFacts, ...referenceFacts];

    if (!hasCapabilityFacts(facts)) {
      const { sections, openItems } = assembleProposal(null, "");
      return {
        output: { sections, open_items: openItems, simulated: false, ai_generated: false },
        summary: `Outlined ${sections.length} proposal sections; no company facts on file to draft from`,
        events: [
          {
            type: "PROPOSAL_GENERATED",
            summary: "Proposal outline generated (no company facts on file; nothing was written)",
            payload: { open_items: openItems },
          },
        ],
        cost: RULES_COST,
      };
    }

    const analysis = analysisOutputSchema.safeParse(ctx.previousOutputs.analysis);
    const requirements = analysis.success ? analysis.data.requirements : [];
    const parts: PromptPart[] = [
      {
        type: "text",
        category: "PUBLIC_TENDER_DATA",
        label: "tender_record",
        cache: true,
        text: wrapUntrusted({ kind: "tender_record", id: t.id, title: "Tender record", text: renderTenderRecord(t) }),
      },
    ];
    if (requirements.length && ctx.granted.has("TENDER_DOCUMENTS")) {
      parts.push({
        type: "text",
        category: "TENDER_DOCUMENTS",
        label: "tender_requirements",
        cache: true,
        text: wrapUntrusted({
          kind: "tender_requirements",
          id: "analysis",
          title: "Requirements from the analysis step",
          text: renderRequirements(requirements),
        }),
      });
    }
    parts.push(...factParts(facts));

    const factIds = new Set(facts.map((f) => f.id));
    const requirementIds = new Set(requirements.map((r) => r.id));
    const threshold = ai.config.highValueThresholdZar;
    await ctx.progress(40, "Drafting sections");
    const model = await generateStructured({
      runtime: ai,
      label: "proposal.draft",
      routing: { highValue: threshold !== null && Number(t.estimated_value_zar ?? 0) >= threshold },
      system: SYSTEM,
      prompt: buildPrompt(parts, ctx.granted),
      instruction: "Draft the outline sections from the company facts and tender requirements above.",
      schema: proposalModelSchema,
      validate: (m) => validateProposal(m, factIds, requirementIds),
    });

    // Figures in the draft must be traceable to the facts, the requirements or the tender record.
    const source = [renderTenderRecord(t), renderRequirements(requirements, 500), renderFacts(facts)].join("\n");
    const { sections, openItems } = assembleProposal(model, source);
    const drafted = sections.filter((s) => s.status !== "MISSING_INFORMATION").length;
    return {
      output: { sections, open_items: openItems, simulated: false, ai_generated: true },
      summary: `AI draft of ${drafted} of ${sections.length} proposal sections for review; ${openItems} still need information or confirmation`,
      events: [
        {
          type: "PROPOSAL_GENERATED",
          summary: "Proposal AI draft generated for review (every paragraph cites its facts; nothing invented)",
          payload: { open_items: openItems, drafted },
        },
      ],
      cost: ai.meter.toCostRecord(),
    };
  },
};
