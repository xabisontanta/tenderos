import { numbersIn } from "@/agents/runtime/ai/guardrails/numbers";
import type { PricingLine, PricingModel, PricingOutput } from "./schema";

/** South African standard VAT rate. */
export const SA_VAT_RATE = 0.15;

/** Sums line totals; returns null if any line lacks a confirmed quantity or price. */
export function subtotal(lines: PricingLine[]): number | null {
  let total = 0;
  for (const l of lines) {
    if (l.quantity == null || l.unit_price_zar == null) return null;
    total += l.quantity * l.unit_price_zar;
  }
  return Math.round(total * 100) / 100;
}

export function withVat(amount: number, rate = SA_VAT_RATE): number {
  return Math.round(amount * (1 + rate) * 100) / 100;
}

// ---------------------------------------------------------------------------
// AI-assisted structuring (never prices)
// ---------------------------------------------------------------------------

/** A requirement from the analysis step, as far as pricing needs it. */
export interface AnalysedRequirement {
  id: string;
  category: string;
  text: string;
  mandatory: boolean;
  status: string;
  source: { kind: string; page?: number; quote?: string };
}

/** Requirements that came from tender documents and concern the price schedule, BOQ or VAT. */
export function priceRequirements(reqs: AnalysedRequirement[]): AnalysedRequirement[] {
  return reqs.filter((r) => r.category === "PRICING" && r.source.kind === "TENDER_DOCUMENT");
}

export const FIXED_NOTES = ["No supplier quotations or pricing rules on file; no prices were generated", "Final pricing requires human approval"];

/** Problems with the model's structuring, sent back once for repair. */
export function validatePricing(model: PricingModel, priceIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  model.lines.forEach((l, i) => {
    if (!priceIds.has(l.requirement_id)) issues.push(`lines[${i}] uses requirement id "${l.requirement_id}", which is not one of the supplied price schedule requirements`);
    else if (seen.has(l.requirement_id)) issues.push(`requirement "${l.requirement_id}" is used for more than one line`);
    seen.add(l.requirement_id);
  });
  if (model.vat.treatment !== "NOT_STATED" && !priceIds.has(model.vat.requirement_id)) {
    issues.push(`vat cites requirement id "${model.vat.requirement_id}", which is not one of the supplied requirements; use NOT_STATED if none says`);
  }
  return issues;
}

const VAT_WORDS = /\bVAT\b|value[- ]added tax/i;
const MAX_NOTES = 5;

/**
 * Builds the stored schedule from the analysed requirements. Every amount
 * stays empty: prices need supplier quotations and a person (AGENTS.md
 * section 13). A quantity survives only if the tender's printed line contains
 * it, and a VAT treatment only if a requirement that mentions VAT backs it.
 */
export function assemblePricing(model: PricingModel, priced: AnalysedRequirement[]): Omit<PricingOutput, "simulated" | "ai_generated"> {
  const order = new Map(priced.map((r, i) => [r.id, i]));
  const byId = new Map(priced.map((r) => [r.id, r]));

  const lines: PricingLine[] = model.lines
    .filter((l) => byId.has(l.requirement_id))
    .sort((a, b) => (order.get(a.requirement_id) ?? 0) - (order.get(b.requirement_id) ?? 0))
    .map((l) => {
      const r = byId.get(l.requirement_id)!;
      const printed = r.source.quote ?? r.text;
      const warnings: string[] = [];
      let quantity = l.quantity;
      if (quantity !== null && !numbersIn(`${printed} ${r.text}`).includes(String(quantity))) {
        warnings.push(`The quantity ${quantity} is not printed in the quoted line; confirm it from the tender`);
        quantity = null;
      }
      if (r.status !== "EXTRACTED") warnings.push("The source requirement is unconfirmed: its quote could not be verified against the document");
      return {
        description: l.description.trim().slice(0, 300),
        quantity,
        unit: l.unit.trim() || null,
        unit_price_zar: null,
        source: "MISSING_INFORMATION" as const,
        ...(l.item_ref.trim() ? { item_ref: l.item_ref.trim().slice(0, 40) } : {}),
        requirement_id: r.id,
        quote: printed.slice(0, 500),
        ...(r.source.page !== undefined ? { page: r.source.page } : {}),
        supplier_quote_likely: l.supplier_quote_likely,
        ...(warnings.length ? { warning: warnings.join("; ") } : {}),
      };
    });

  const statedBy = byId.get(model.vat.requirement_id);
  const vatStated = model.vat.treatment !== "NOT_STATED" && !!statedBy && VAT_WORDS.test(`${statedBy.text} ${statedBy.source.quote ?? ""}`);
  const treatment = vatStated ? model.vat.treatment : "NOT_STATED";
  const vat = {
    rate: SA_VAT_RATE,
    treatment,
    status: vatStated ? ("STATED" as const) : ("REQUIRES_CONFIRMATION" as const),
    ...(vatStated ? { requirement_id: model.vat.requirement_id } : {}),
  };

  const supplierLines = lines.filter((l) => l.supplier_quote_likely).length;
  const notes = [
    ...FIXED_NOTES,
    vatStated
      ? `The tender states figures are quoted ${treatment === "EXCLUSIVE" ? "exclusive" : "inclusive"} of VAT (South African VAT is 15%)`
      : "VAT treatment is not stated in the analysed requirements; confirm whether figures are inclusive or exclusive of VAT (South African VAT is 15%)",
    ...(supplierLines ? [`${supplierLines} line${supplierLines === 1 ? "" : "s"} will likely need a supplier quotation before a price can be entered`] : []),
    ...model.notes.map((n) => n.trim().slice(0, 300)).filter(Boolean).slice(0, MAX_NOTES),
  ];

  return {
    currency: "ZAR",
    vat_rate: SA_VAT_RATE,
    lines,
    subtotal_zar: null,
    status: "REQUIRES_CONFIRMATION",
    notes,
    requires_human_approval: true,
    vat,
  };
}
