import { ungroundedNumbers } from "@/agents/runtime/ai/guardrails/numbers";
import type { ProposalModel, ProposalSection } from "./schema";

/** The fixed outline. A model fills sections in; it cannot add, rename or reorder them. */
export const PROPOSAL_SECTIONS: Array<{ key: string; title: string; needs: string[] }> = [
  { key: "executive_summary", title: "Executive summary", needs: ["Company overview", "Confirmed scope understanding"] },
  { key: "methodology", title: "Methodology and approach", needs: ["Company delivery methodology"] },
  { key: "delivery_schedule", title: "Delivery schedule", needs: ["Delivery capacity", "Contract duration from tender documents"] },
  { key: "staffing", title: "Key personnel", needs: ["Verified staff list and qualifications"] },
  { key: "experience", title: "Relevant experience and references", needs: ["Verified project references"] },
  { key: "quality", title: "Quality management", needs: ["Quality certifications or procedures"] },
];

export { ungroundedNumbers };

/** Problems that make a draft unusable. They go back to the model once for repair. */
export function validateProposal(model: ProposalModel, factIds: ReadonlySet<string>, requirementIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  model.sections.forEach((s, i) => {
    s.paragraphs.forEach((p, j) => {
      const where = `sections[${i}] (${s.key}) paragraph ${j + 1}`;
      if (p.fact_ids.length === 0 && p.requirement_ids.length === 0) issues.push(`${where} cites no fact and no requirement; every paragraph must cite what it rests on, or the section must be MISSING_INFORMATION`);
      for (const id of p.fact_ids) if (!factIds.has(id)) issues.push(`${where} cites fact id "${id}", which is not one of the supplied company facts`);
      for (const id of p.requirement_ids) if (!requirementIds.has(id)) issues.push(`${where} cites requirement id "${id}", which is not one of the supplied requirements`);
    });
  });
  return issues;
}

const MAX_NEEDS = 10;

/**
 * Builds the stored sections from the outline and the model's draft. Text with
 * figures that are not in the facts or requirements is removed and reported,
 * and a section with nothing left is MISSING_INFORMATION (AGENTS.md section 13).
 */
export function assembleProposal(model: ProposalModel | null, source: string): { sections: ProposalSection[]; openItems: number } {
  const sections = PROPOSAL_SECTIONS.map((outline): ProposalSection => {
    const drafted = model?.sections.find((s) => s.key === outline.key);
    if (!drafted) return { key: outline.key, title: outline.title, status: "MISSING_INFORMATION", content: null, needs: outline.needs };

    const warnings: string[] = [];
    const kept = drafted.paragraphs.filter((p) => {
      const bad = ungroundedNumbers(p.text, source);
      if (bad.length === 0) return true;
      warnings.push(`A paragraph was removed because it states figures that are not in the company facts or tender requirements (${bad.join(", ")}): "${p.text.slice(0, 100)}"`);
      return false;
    });
    const needs = drafted.needs.map((n) => n.trim()).filter(Boolean).slice(0, MAX_NEEDS);
    if (kept.length === 0) {
      return { key: outline.key, title: outline.title, status: "MISSING_INFORMATION", content: null, needs: needs.length ? needs : outline.needs, ...(warnings.length ? { warnings } : {}) };
    }
    const complete = drafted.status === "DRAFTED" && warnings.length === 0 && needs.length === 0;
    return {
      key: outline.key,
      title: outline.title,
      status: complete ? "DRAFTED" : "REQUIRES_CONFIRMATION",
      content: kept.map((p) => p.text.trim()).join("\n\n"),
      needs,
      paragraphs: kept,
      ...(warnings.length ? { warnings } : {}),
    };
  });
  return { sections, openItems: sections.filter((s) => s.status !== "DRAFTED").length };
}
