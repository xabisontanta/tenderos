import { analysisOutputSchema } from "@/agents/analysis/schema";
import { complianceOutputSchema } from "@/agents/compliance/schema";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import { RULES_COST, requireAi } from "@/agents/runtime/ai/context";
import { buildPrompt, type PromptPart } from "@/agents/runtime/ai/guardrails/data-policy";
import { wrapUntrusted } from "@/agents/runtime/ai/guardrails/text";
import { buildSystemPrompt } from "@/agents/runtime/ai/prompts";
import { renderRequirements, renderTenderRecord } from "@/agents/runtime/ai/render";
import { generateStructured } from "@/agents/runtime/ai/structured";
import { NonRetryableError, type AgentExecutor, type CostRecord, type DomainEvent } from "@/agents/runtime/types";
import { buildEvidence, coverageChecks, findingChecks, MAX_REVIEWED_REQUIREMENTS, reviewBid, reviewSet, verdictOf } from "./logic";
import { qaModelSchema, qaOutputSchema, type QaCheck, type QaOutput } from "./schema";

const SYSTEM = buildSystemPrompt({
  role: "QA Reviewer",
  mission:
    "Independently review a bid against the tender's requirements before a person approves it. Find what the bid does not yet answer. You can add concerns for the approver; you cannot approve, pass or fail a bid.",
  rules: [
    "Missing information is an open issue, never a pass. If you cannot tell whether a requirement is addressed, say CANNOT_DETERMINE.",
    "A requirement is ADDRESSED only if specific bid content answers it. Cite the bracketed ids of that content exactly as written: [section:...] for proposal sections, [compliance:...] for compliance items, [pricing:...] for schedule lines. Never cite an id that is not shown.",
    "Content marked MISSING_INFORMATION, REQUIRES_CONFIRMATION, EXPIRED or unconfirmed does not address a requirement completely. Use PARTIALLY_ADDRESSED or NOT_ADDRESSED.",
    "Judge only what is shown. Do not assume documents, signatures, declarations or prices exist unless the bid content or compliance list shows them.",
    "Report inconsistencies: places where the bid contradicts itself or the requirements (dates, durations, quantities, scope, grades). Cite the ids involved.",
    "Use other_issues for anything else the approver should check, such as signatures, declarations or physical delivery. Keep each to one sentence.",
  ],
});

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * QA Reviewer (AI, HIGH tier): the rule checks run first (deadline, completed
 * steps, eligibility, missing documents, open proposal sections, unpriced
 * schedule). A hard failure there ends the review. Otherwise the model
 * reviews coverage of every analysed requirement. A requirement passes only
 * when the model cites bid content that exists and is complete; anything else
 * is an open issue for the approver. The model can add issues, never remove
 * one, and never produce a FAIL.
 */
export const qaReviewReal: AgentExecutor<QaOutput> = {
  taskType: "qa.review",
  agent: "quality_assurance",
  requires: ["PUBLIC_TENDER_DATA"],
  optional: ["TENDER_DOCUMENTS", "PRICING", "COMPANY_PROFILE"],
  tools: ["bid.read"],
  ai: true,
  outputSchema: qaOutputSchema,
  async run(ctx) {
    const ai = requireAi(ctx);
    const t = ctx.tender;
    if (!t) throw new NonRetryableError("Tender data unavailable");

    await ctx.tools.run("bid.read", async () => undefined);
    const rules = reviewBid(t, ctx.previousOutputs, ctx.now);
    const done = (checks: QaCheck[], note: string | undefined, cost: CostRecord, aiUsed: boolean) => {
      const { verdict, open_issues } = verdictOf(checks);
      const events: DomainEvent[] = [
        verdict === "FAIL"
          ? { type: "QA_FAIL", severity: "ERROR", summary: "Quality assurance failed", payload: { issues: open_issues } }
          : {
              type: "QA_PASS",
              summary: verdict === "PASS" ? "Quality assurance passed" : "QA passed with open issues",
              payload: { verdict, issues: open_issues },
            },
      ];
      return {
        output: { verdict, checks, open_issues, simulated: false, ai_generated: aiUsed, ...(note ? { ai_note: note } : {}) } satisfies QaOutput,
        summary:
          verdict === "FAIL"
            ? `QA failed: ${open_issues.length} problems`
            : verdict === "CONDITIONAL"
              ? `QA passed with ${open_issues.length} open issues for the approver`
              : "QA passed",
        events,
        cost,
      };
    };

    if (rules.verdict === "FAIL")
      return done(rules.checks, "Not run: the rule checks already found a hard failure, which an AI review cannot change", RULES_COST, false);

    const analysis = analysisOutputSchema.safeParse(ctx.previousOutputs.analysis);
    const { reviewed, skipped } = reviewSet(analysis.success && ctx.granted.has("TENDER_DOCUMENTS") ? analysis.data.requirements : []);
    if (reviewed.length === 0) {
      const gap: QaCheck = {
        key: "coverage",
        label: "Requirement coverage",
        result: "OPEN_ISSUE",
        detail: "No requirements read from the tender documents were available to review the bid against",
      };
      return done(
        [...rules.checks, gap],
        "Not run: no analysed requirements to review against; coverage of the tender's requirements is unverified",
        RULES_COST,
        false,
      );
    }

    const evidence = buildEvidence(ctx.previousOutputs);
    const proposal = proposalOutputSchema.safeParse(ctx.previousOutputs.proposal);
    const compliance = complianceOutputSchema.safeParse(ctx.previousOutputs.compliance);
    const pricing = pricingOutputSchema.safeParse(ctx.previousOutputs.pricing);

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
        label: "tender_requirements",
        cache: true,
        text: wrapUntrusted({
          kind: "tender_requirements",
          id: "analysis",
          title: "Requirements to review the bid against",
          text: renderRequirements(reviewed, MAX_REVIEWED_REQUIREMENTS),
        }),
      },
    ];
    if (proposal.success) {
      const text = proposal.data.sections
        .map(
          (s) =>
            `[section:${s.key}] (${s.status}) ${s.title}: ${s.content ? trim(s.content, 1200) : "(no content)"}${s.needs.length ? ` | still needs: ${s.needs.join("; ")}` : ""}`,
        )
        .join("\n");
      parts.push({
        type: "text",
        category: "COMPANY_PROFILE",
        label: "proposal_sections",
        cache: true,
        text: wrapUntrusted({ kind: "bid_proposal", id: "proposal", title: "Proposal sections", text }),
      });
    }
    if (compliance.success) {
      // Statuses only: the evidence text can carry company registration numbers.
      const text = compliance.data.items.map((i) => `[compliance:${i.key}] ${i.label}${i.mandatory ? " (mandatory)" : ""}: ${i.status}`).join("\n");
      parts.push({
        type: "text",
        category: "COMPANY_PROFILE",
        label: "compliance_items",
        cache: true,
        text: wrapUntrusted({ kind: "bid_compliance", id: "compliance", title: "Compliance checklist", text }),
      });
    }
    if (pricing.success) {
      const lines = pricing.data.lines.map(
        (l) =>
          `[pricing:${l.requirement_id ?? "line"}] ${l.description}${l.quantity != null ? `, ${l.quantity} ${l.unit ?? ""}` : ""}: price ${l.unit_price_zar == null ? "not entered" : "entered"}`,
      );
      const text = [`Schedule status: ${pricing.data.status}`, ...lines].join("\n");
      parts.push({
        type: "text",
        category: "PRICING",
        label: "pricing_schedule",
        cache: true,
        text: wrapUntrusted({ kind: "bid_pricing", id: "pricing", title: "Pricing schedule", text }),
      });
    }

    await ctx.progress(35, "Reviewing the bid against the requirements");
    const model = await generateStructured({
      runtime: ai,
      label: "qa.review",
      system: SYSTEM,
      prompt: buildPrompt(parts, ctx.granted),
      instruction: "Review the bid content against the requirements above.",
      schema: qaModelSchema,
    });

    const validRefs = new Set<string>([...evidence.keys(), ...reviewed.map((r) => r.id)]);
    const checks: QaCheck[] = [...rules.checks, ...coverageChecks(reviewed, model, evidence), ...findingChecks(model, validRefs)];
    if (skipped > 0) {
      checks.push({
        key: "coverage",
        label: "Requirement coverage",
        result: "OPEN_ISSUE",
        detail: `${skipped} further requirement${skipped === 1 ? "" : "s"} were not reviewed (limit of ${MAX_REVIEWED_REQUIREMENTS} per review)`,
      });
    }
    return done(checks, undefined, ai.meter.toCostRecord(), true);
  },
};
