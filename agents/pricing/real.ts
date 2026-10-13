import { analysisOutputSchema } from "@/agents/analysis/schema";
import { RULES_COST, requireAi } from "@/agents/runtime/ai/context";
import { buildPrompt, type PromptPart } from "@/agents/runtime/ai/guardrails/data-policy";
import { wrapUntrusted } from "@/agents/runtime/ai/guardrails/text";
import { buildSystemPrompt } from "@/agents/runtime/ai/prompts";
import { renderTenderRecord } from "@/agents/runtime/ai/render";
import { generateStructured } from "@/agents/runtime/ai/structured";
import { NonRetryableError, type AgentExecutor } from "@/agents/runtime/types";
import { FIXED_NOTES, SA_VAT_RATE, assemblePricing, priceRequirements, validatePricing, type AnalysedRequirement } from "./logic";
import { pricingModelSchema, pricingOutputSchema, type PricingOutput } from "./schema";

const SYSTEM = buildSystemPrompt({
  role: "Pricing Analyst",
  mission:
    "Turn the price schedule or bill of quantities lines found in the tender analysis into a structured list for a person to price. You structure; you never price. Every amount is entered later by a person from supplier quotations.",
  rules: [
    "You have no field for a price, rate, amount or total and must never write one, in any field, note or description, even if a requirement mentions a figure for something else.",
    "Each schedule line is one analysed requirement, shown as a line in brackets such as [doc-7] with the tender's printed line after 'quote'. Use the requirement's id exactly as written. Use each requirement at most once, and skip requirements that are instructions rather than priced lines.",
    "Give a quantity only if the printed line states it; otherwise null. Copy units as printed.",
    "Set supplier_quote_likely to true for lines a bidder would normally buy in (materials, equipment, subcontracted work) and false for lines priced from the bidder's own labour or overheads.",
    "Report the VAT treatment only if a requirement that mentions VAT says whether figures are exclusive or inclusive; cite that requirement's id. Otherwise use NOT_STATED. South African VAT is 15%.",
    "In notes, record anything a person completing the schedule must know that the requirements state (for example escalation, provisional sums or how to complete the schedule).",
  ],
});

function requirementLine(r: AnalysedRequirement): string {
  const quote = r.source.quote ? ` | quote: "${r.source.quote}"` : "";
  return `[${r.id}] (${r.category}${r.status === "EXTRACTED" ? "" : ", unconfirmed"}) ${r.text}${quote}`;
}

/**
 * Pricing Analyst (AI): structures the price schedule from the analysed
 * requirements and flags where supplier quotations and VAT need attention. It
 * has no way to produce a figure: the model schema has no price field, every
 * amount in the result is null, and a person enters them (AGENTS.md section 13).
 */
export const pricingPrepareReal: AgentExecutor<PricingOutput> = {
  taskType: "pricing.prepare",
  agent: "pricing",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["TENDER_DOCUMENTS"],
  tools: ["pricing.model"],
  ai: true,
  outputSchema: pricingOutputSchema,
  async run(ctx) {
    const ai = requireAi(ctx);
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");

    const analysis = analysisOutputSchema.safeParse(ctx.previousOutputs.analysis);
    const priced = analysis.success && ctx.granted.has("TENDER_DOCUMENTS") ? priceRequirements(analysis.data.requirements) : [];
    await ctx.tools.run("pricing.model", async () => undefined);

    if (priced.length === 0) {
      return {
        output: {
          currency: "ZAR",
          vat_rate: SA_VAT_RATE,
          lines: [],
          subtotal_zar: null,
          status: "REQUIRES_CONFIRMATION",
          notes: ["The analysis found no price schedule or bill of quantities lines; a person must supply the pricing structure", ...FIXED_NOTES],
          requires_human_approval: true,
          vat: { rate: SA_VAT_RATE, treatment: "NOT_STATED", status: "REQUIRES_CONFIRMATION" },
          simulated: false,
          ai_generated: false,
        },
        summary: "No price schedule lines in the analysis; nothing to structure and no figures generated",
        events: [{ type: "PRICING_READY", summary: "Pricing structure empty: no schedule lines were found (no figures generated)" }],
        cost: RULES_COST,
      };
    }

    const parts: PromptPart[] = [
      {
        type: "text",
        category: "PUBLIC_TENDER_DATA",
        label: "tender_record",
        cache: true,
        text: wrapUntrusted({ kind: "tender_record", id: t.id, title: "Tender record", text: renderTenderRecord(t) }),
      },
      {
        type: "text",
        category: "TENDER_DOCUMENTS",
        label: "price_requirements",
        cache: true,
        text: wrapUntrusted({
          kind: "tender_requirements",
          id: "pricing",
          title: "Price schedule requirements from the analysis step",
          text: priced.map(requirementLine).join("\n"),
        }),
      },
    ];
    const priceIds = new Set(priced.map((r) => r.id));
    const threshold = ai.config.highValueThresholdZar;
    await ctx.progress(40, "Structuring the price schedule");
    const model = await generateStructured({
      runtime: ai,
      label: "pricing.structure",
      routing: { highValue: threshold !== null && Number(t.estimated_value_zar ?? 0) >= threshold },
      system: SYSTEM,
      prompt: buildPrompt(parts, ctx.granted),
      instruction: "Structure the schedule lines from the requirements above and report the VAT treatment.",
      schema: pricingModelSchema,
      validate: (m) => validatePricing(m, priceIds),
    });

    const schedule = assemblePricing(model, priced);
    return {
      output: { ...schedule, simulated: false, ai_generated: true },
      summary: `Structured ${schedule.lines.length} schedule line${schedule.lines.length === 1 ? "" : "s"}; no figures generated, prices need quotations and human input`,
      events: [{ type: "PRICING_READY", summary: "Pricing structure ready (no figures without quotations)", payload: { lines: schedule.lines.length } }],
      cost: ai.meter.toCostRecord(),
    };
  },
};
