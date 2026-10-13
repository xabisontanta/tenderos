import type { PricingLine, PricingOutput } from "@/agents/pricing/schema";
import type { ProposalOutput, ProposalSection } from "@/agents/proposal/schema";
import { priceSchedule, SA_VAT_PERCENT } from "./bid-money";
import type { TenderStatus } from "./tender-state";

/**
 * The bid content a person reviews and enters: proposal sections and the pricing schedule. The AI's drafts seed it; from
 * then on a person's text and figures are what the bid is. QA and the Submission Officer read the content through the
 * functions here, so what they check is what the person approved, not the first draft.
 *
 * The database enforces every rule below in its own functions (migration 072); these are the same rules for the screens and
 * for turning the stored rows back into the output shapes the agents already understand.
 */

export type SectionStatus = "DRAFT" | "MISSING_INFORMATION" | "REVIEWED";

/** Whether a bid's content can be edited in a given tender status. Mirrors private.prepare_bid_edit() in migration 072. */
export type BidEditState = "editable" | "withdraws_approval" | "locked";

const EDITABLE: readonly TenderStatus[] = ["PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED", "COMPLIANCE_REVIEW", "MISSING_INFORMATION"];

/** Editable before approval; editing while it waits for approval withdraws the approval; once approved or closed it is locked. */
export function bidEditState(status: TenderStatus): BidEditState {
  if (status === "READY_FOR_APPROVAL") return "withdraws_approval";
  return EDITABLE.includes(status) ? "editable" : "locked";
}

export interface SectionState {
  content: string | null;
  status: SectionStatus;
  /** The current text was written by the AI and no person has changed it. */
  ai_generated: boolean;
  edited_by: string | null;
  reviewed_by: string | null;
}

const blank = (s: string | null | undefined): boolean => s === null || s === undefined || s.trim() === "";

/** A section as it first lands from the Proposal Writer. `aiWrote` is true when a model wrote the text. */
export function seedState(draft: { content: string | null; aiWrote: boolean }): SectionState {
  if (blank(draft.content)) return { content: null, status: "MISSING_INFORMATION", ai_generated: false, edited_by: null, reviewed_by: null };
  return { content: draft.content, status: "DRAFT", ai_generated: draft.aiWrote, edited_by: null, reviewed_by: null };
}

/** After a person saves new text: theirs from now on, a draft again, and any earlier review no longer applies. */
export function afterEdit(_before: SectionState, text: string, editor: string): SectionState {
  const content = text.trim() === "" ? null : text.trim();
  return { content, status: content === null ? "MISSING_INFORMATION" : "DRAFT", ai_generated: false, edited_by: editor, reviewed_by: null };
}

export const canReview = (s: SectionState): boolean => s.status === "DRAFT" && !blank(s.content);
export const canUnreview = (s: SectionState): boolean => s.status === "REVIEWED";

export type Transition = { ok: true; state: SectionState } | { ok: false; error: string };

export function reviewSection(s: SectionState, reviewer: string): Transition {
  if (s.status === "REVIEWED") return { ok: false, error: "This section has already been reviewed" };
  if (!canReview(s)) return { ok: false, error: "A section needs text before it can be reviewed" };
  return { ok: true, state: { ...s, status: "REVIEWED", reviewed_by: reviewer } };
}

export function unreviewSection(s: SectionState): Transition {
  if (!canUnreview(s)) return { ok: false, error: "This section has not been reviewed" };
  return { ok: true, state: { ...s, status: "DRAFT", reviewed_by: null } };
}

/** A new AI draft may replace a section only while no person has edited or reviewed it. */
export const mayReplaceWithNewDraft = (s: Pick<SectionState, "edited_by" | "reviewed_by">): boolean => s.edited_by === null && s.reviewed_by === null;

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface BidSectionRow {
  section_key: string;
  title: string;
  position: number;
  content: string | null;
  status: SectionStatus;
  ai_generated: boolean;
  needs: string[];
  warnings: string[];
}

/**
 * The proposal as the agents read it. A section is complete (DRAFTED) only when a person reviewed it and it has text; a draft
 * nobody has reviewed is REQUIRES_CONFIRMATION and a section with no text is MISSING_INFORMATION. That is the rule QA uses
 * for coverage evidence, applied to what the person actually wrote.
 */
export function proposalFromSections(rows: readonly BidSectionRow[]): ProposalOutput {
  const sections = [...rows]
    .sort((a, b) => a.position - b.position || a.section_key.localeCompare(b.section_key))
    .map((r): ProposalSection => {
      const hasText = !blank(r.content);
      const status: ProposalSection["status"] = !hasText ? "MISSING_INFORMATION" : r.status === "REVIEWED" ? "DRAFTED" : "REQUIRES_CONFIRMATION";
      return {
        key: r.section_key,
        title: r.title,
        status,
        content: hasText ? r.content : null,
        needs: status === "DRAFTED" ? [] : r.needs.length ? r.needs : ["Text written or confirmed by a person"],
        ...(r.warnings.length && status !== "DRAFTED" ? { warnings: r.warnings } : {}),
      };
    });
  return {
    sections,
    open_items: sections.filter((s) => s.status !== "DRAFTED").length,
    simulated: false,
    ai_generated: rows.some((r) => r.ai_generated),
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface BidPricingRow {
  vat_treatment: "EXCLUSIVE" | "INCLUSIVE" | "NOT_STATED";
  vat_status: "STATED" | "REQUIRES_CONFIRMATION";
  vat_requirement_id: string | null;
  notes: string[];
  ai_generated: boolean;
  /** A person confirmed the schedule; any later change to a figure clears it. */
  confirmed: boolean;
}

export interface BidPricingLineRow {
  id: string;
  position: number;
  /** TENDER: a line the analysis found in the schedule. PERSON: a line a person added. */
  source: "TENDER" | "PERSON";
  description: string;
  item_ref: string | null;
  /** Normalised decimal string; null when the tender prints none and nobody entered one. */
  quantity: string | null;
  /** True when the quantity is the tender's printed one, which a bidder cannot change. */
  quantity_printed: boolean;
  unit: string | null;
  unit_price_cents: number | null;
  supplier_quote_ref: string | null;
  supplier_quote_likely: boolean;
  requirement_id: string | null;
  quote: string | null;
  page: number | null;
  warning: string | null;
}

/**
 * The pricing schedule as the agents read it. Figures are the person's, in rands from whole cents. The schedule is ready for
 * approval only when it has lines, every line has a quantity and a price, and a person has confirmed it.
 */
export function pricingFromRows(bid: BidPricingRow, rows: readonly BidPricingLineRow[]): PricingOutput {
  const lines = [...rows].sort((a, b) => a.position - b.position);
  const totals = priceSchedule(lines.map((l) => ({ quantity: l.quantity, unitPriceCents: l.unit_price_cents })));
  const ready = bid.confirmed && totals.complete;
  return {
    currency: "ZAR",
    vat_rate: SA_VAT_PERCENT / 100,
    lines: lines.map((l): PricingLine => {
      const priced = l.unit_price_cents !== null;
      return {
        description: l.description,
        quantity: l.quantity === null ? null : Number(l.quantity),
        unit: l.unit,
        unit_price_zar: priced ? l.unit_price_cents! / 100 : null,
        source: !priced ? "MISSING_INFORMATION" : l.supplier_quote_ref ? "SUPPLIER_QUOTE" : "RATE_CARD",
        ...(l.item_ref ? { item_ref: l.item_ref } : {}),
        ...(l.requirement_id ? { requirement_id: l.requirement_id } : {}),
        ...(l.quote ? { quote: l.quote } : {}),
        ...(l.page !== null ? { page: l.page } : {}),
        supplier_quote_likely: l.supplier_quote_likely,
        ...(l.warning ? { warning: l.warning } : {}),
      };
    }),
    subtotal_zar: totals.complete ? totals.subtotalCents / 100 : null,
    status: ready ? "READY_FOR_APPROVAL" : "REQUIRES_CONFIRMATION",
    notes: bid.notes,
    requires_human_approval: true,
    simulated: false,
    vat: {
      rate: SA_VAT_PERCENT / 100,
      treatment: bid.vat_treatment,
      status: bid.vat_status,
      ...(bid.vat_requirement_id ? { requirement_id: bid.vat_requirement_id } : {}),
    },
    ai_generated: bid.ai_generated,
  };
}
