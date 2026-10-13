import { analysisOutputSchema } from "@/agents/analysis/schema";
import { RULES_COST, requireAi } from "@/agents/runtime/ai/context";
import { companyFacts, factParts, hasCapabilityFacts } from "@/agents/runtime/ai/facts";
import { buildPrompt, type PromptPart } from "@/agents/runtime/ai/guardrails/data-policy";
import { wrapUntrusted } from "@/agents/runtime/ai/guardrails/text";
import { buildSystemPrompt } from "@/agents/runtime/ai/prompts";
import { renderRequirements, renderTenderRecord } from "@/agents/runtime/ai/render";
import { generateStructured } from "@/agents/runtime/ai/structured";
import { NonRetryableError, type AgentExecutor, type DomainEvent } from "@/agents/runtime/types";
import { assessQualification, companyFitInputs, fitFactor, validateFit } from "./logic";
import { aiFitModelSchema, qualificationOutputSchema, type QualificationOutput } from "./schema";

const SYSTEM = buildSystemPrompt({
  role: "Qualification Agent",
  mission:
    "Judge how well the company's recorded facts fit a tender, so a person can decide whether to bid. You advise; the rule checks and the person decide. Your assessment never rejects or qualifies a tender.",
  rules: [
    "Compare only the company facts and the tender requirements you were given. A fact is a line in brackets such as [fact:cidb_grade]; a requirement is a line such as [doc-1].",
    "Give each reason one assessment: SUPPORTS only if a company fact backs it, and then cite that fact id; CONCERN if the facts conflict with the tender; UNKNOWN if the facts say nothing. Never assume experience, certificates, staff, equipment or finances that are not in the facts.",
    "Cite requirement ids for the tender requirements a reason relates to. Cite ids exactly as written in the brackets; never invent an id.",
    "Score 0 to 100: how well the recorded facts match what the tender asks. Where facts are missing, the score must not rise; list what is missing in missing_information.",
    "Set confidence to LOW when the recorded facts are too thin to judge the fit.",
    "List risks a bidder should know about, such as a compulsory briefing, a CIDB grade above the company's, or a province the company does not work in.",
  ],
});

/**
 * Qualification Agent (AI): the rule gates (48 hours, compulsory briefing,
 * contract size) run first and decide. Only a tender that passes them gets
 * an AI fit assessment against the company profile: a score, reasons that
 * cite company facts, and risks. The assessment is added to the result; it
 * can never turn a failed gate into a pass.
 */
export const opportunityQualificationReal: AgentExecutor<QualificationOutput> = {
  taskType: "qualification.assess",
  agent: "opportunity_qualification",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["COMPANY_PROFILE", "COMPANY_CAPABILITIES", "TENDER_DOCUMENTS"],
  tools: ["company.capabilities.read"],
  ai: true,
  outputSchema: qualificationOutputSchema,
  async run(ctx) {
    const ai = requireAi(ctx);
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");

    const rules = assessQualification(t, ctx.now, companyFitInputs(ctx.company));
    const qualified = rules.decision === "QUALIFIED";
    const decisionEvent = (extra: Record<string, unknown> = {}): DomainEvent =>
      qualified
        ? { type: "TENDER_QUALIFIED", summary: "Tender passed qualification checks", payload: { fit_score: rules.fit_score, ...extra } }
        : { type: "TENDER_REJECTED", severity: "WARNING", summary: "Tender failed a hard disqualifier", payload: { reasons: rules.hard_disqualifiers } };
    const without = (note: string, summary: string): ReturnType<AgentExecutor<QualificationOutput>["run"]> =>
      Promise.resolve({
        output: { ...rules, simulated: false, ai_fit: null, ai_note: note },
        summary,
        events: [decisionEvent()],
        cost: RULES_COST,
      });

    if (!qualified)
      return without(
        "Not run: a hard disqualifier already rejects this tender, and an AI assessment cannot change that",
        `Rejected: ${rules.hard_disqualifiers.join("; ")}`,
      );

    await ctx.progress(20, "Reading the company facts");
    const facts = await ctx.tools.run("company.capabilities.read", async () => companyFacts(ctx.company, ctx.documents, ctx.granted, ctx.now));
    if (!hasCapabilityFacts(facts)) {
      return without(
        "Not run: the company profile has no sectors, provinces, CIDB grade or experience to compare with this tender. Complete the company profile",
        `Qualified pending confirmation of company capability`,
      );
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
    await ctx.progress(45, "Assessing fit");
    const fit = await generateStructured({
      runtime: ai,
      label: "qualification.fit",
      routing: { highValue: threshold !== null && Number(t.estimated_value_zar ?? 0) >= threshold },
      system: SYSTEM,
      prompt: buildPrompt(parts, ctx.granted),
      instruction: "Assess how well the company facts fit this tender.",
      schema: aiFitModelSchema,
      validate: (f) => validateFit(f, factIds, requirementIds),
      maxTokens: 8000,
    });

    const factor = fitFactor(fit);
    const output: QualificationOutput = {
      ...rules,
      factors: [...rules.factors, factor],
      confirmation_required: rules.confirmation_required || factor.result === "REQUIRES_CONFIRMATION",
      simulated: false,
      ai_fit: { ...fit, ai_generated: true },
    };
    return {
      output,
      summary: `Qualified${output.confirmation_required ? " pending confirmation" : ""}; AI fit ${fit.score}/100 (${fit.confidence.toLowerCase()} confidence) for a person to review`,
      events: [decisionEvent({ ai_fit_score: fit.score })],
      cost: ai.meter.toCostRecord(),
    };
  },
};
