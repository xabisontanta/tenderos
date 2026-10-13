import { describe, expect, it } from "vitest";
import { ALL_TENDER_STATUSES } from "@/lib/domain/tender-state";
import {
  afterEdit,
  bidEditState,
  canReview,
  canUnreview,
  mayReplaceWithNewDraft,
  pricingFromRows,
  proposalFromSections,
  reviewSection,
  seedState,
  unreviewSection,
  type BidPricingLineRow,
  type BidPricingRow,
  type BidSectionRow,
  type SectionState,
} from "@/lib/domain/bid-content";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import { buildEvidence, reviewBid } from "@/agents/qa/logic";
import { packageHash } from "@/agents/submission/logic";

describe("bidEditState: when a bid's content can be edited", () => {
  it.each(["PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED", "COMPLIANCE_REVIEW", "MISSING_INFORMATION"] as const)("%s is editable", (status) => {
    expect(bidEditState(status)).toBe("editable");
  });

  it("withdraws the approval when the bid is waiting for one", () => {
    expect(bidEditState("READY_FOR_APPROVAL")).toBe("withdraws_approval");
  });

  it("is locked once approved, delivered or closed, and before there is any content", () => {
    for (const status of ALL_TENDER_STATUSES) {
      if (["PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED", "COMPLIANCE_REVIEW", "MISSING_INFORMATION", "READY_FOR_APPROVAL"].includes(status))
        continue;
      expect(bidEditState(status), status).toBe("locked");
    }
  });
});

const state = (over: Partial<SectionState> = {}): SectionState => ({
  content: "We have delivered road works since 2011.",
  status: "DRAFT",
  ai_generated: true,
  edited_by: null,
  reviewed_by: null,
  ...over,
});

describe("section state machine", () => {
  describe("seedState: what the Proposal Writer's section becomes", () => {
    it("is a draft to review when the AI wrote text, flagged as AI", () => {
      expect(seedState({ content: "Text", aiWrote: true })).toEqual({
        content: "Text",
        status: "DRAFT",
        ai_generated: true,
        edited_by: null,
        reviewed_by: null,
      });
    });

    it("is missing information when there is no text, and not AI-generated", () => {
      expect(seedState({ content: null, aiWrote: true })).toMatchObject({ content: null, status: "MISSING_INFORMATION", ai_generated: false });
      expect(seedState({ content: "   ", aiWrote: true })).toMatchObject({ content: null, status: "MISSING_INFORMATION" });
    });

    it("is not AI-generated when the run was rules only", () => {
      expect(seedState({ content: "Text", aiWrote: false })).toMatchObject({ ai_generated: false });
    });
  });

  describe("afterEdit", () => {
    it("makes the person the author: no longer AI-generated, a draft again, review cleared", () => {
      const next = afterEdit(state({ status: "REVIEWED", reviewed_by: "u1" }), "Our own words.", "u2");
      expect(next).toEqual({ content: "Our own words.", status: "DRAFT", ai_generated: false, edited_by: "u2", reviewed_by: null });
    });

    it("clearing the text makes the section missing information again", () => {
      expect(afterEdit(state(), "  \n ", "u2")).toMatchObject({ content: null, status: "MISSING_INFORMATION", ai_generated: false, edited_by: "u2" });
    });

    it("trims the text but keeps its paragraphs", () => {
      expect(afterEdit(state(), "  One.\n\nTwo.  ", "u2").content).toBe("One.\n\nTwo.");
    });
  });

  describe("review", () => {
    it("lets a person review a draft that has text", () => {
      expect(reviewSection(state(), "u3")).toEqual({ ok: true, state: state({ status: "REVIEWED", reviewed_by: "u3" }) });
    });

    it("keeps the AI flag when the person reviewed the AI's words as they were", () => {
      const res = reviewSection(state(), "u3");
      expect(res.ok && res.state.ai_generated).toBe(true);
    });

    it("refuses a section with no text", () => {
      expect(reviewSection(state({ content: null, status: "MISSING_INFORMATION" }), "u3")).toMatchObject({ ok: false });
    });

    it("refuses a section that is already reviewed", () => {
      expect(reviewSection(state({ status: "REVIEWED", reviewed_by: "u1" }), "u3")).toMatchObject({ ok: false });
    });

    it("can be taken back to a draft", () => {
      expect(unreviewSection(state({ status: "REVIEWED", reviewed_by: "u1" }))).toEqual({ ok: true, state: state({ status: "DRAFT", reviewed_by: null }) });
      expect(unreviewSection(state())).toMatchObject({ ok: false });
    });

    it("says which sections can be reviewed or un-reviewed", () => {
      expect(canReview(state())).toBe(true);
      expect(canReview(state({ status: "REVIEWED" }))).toBe(false);
      expect(canReview(state({ content: null, status: "MISSING_INFORMATION" }))).toBe(false);
      expect(canUnreview(state({ status: "REVIEWED" }))).toBe(true);
      expect(canUnreview(state())).toBe(false);
    });
  });

  describe("mayReplaceWithNewDraft: the AI never overwrites a person's work", () => {
    it("replaces an untouched draft", () => expect(mayReplaceWithNewDraft(state())).toBe(true));
    it("keeps anything a person edited", () => expect(mayReplaceWithNewDraft(state({ edited_by: "u1", ai_generated: false }))).toBe(false));
    it("keeps anything a person reviewed, even unedited", () => expect(mayReplaceWithNewDraft(state({ status: "REVIEWED", reviewed_by: "u1" }))).toBe(false));
  });
});

const section = (over: Partial<BidSectionRow> = {}): BidSectionRow => ({
  section_key: "executive_summary",
  title: "Executive summary",
  position: 0,
  content: "Text.",
  status: "REVIEWED",
  ai_generated: false,
  needs: [],
  warnings: [],
  ...over,
});

describe("proposalFromSections: what QA and the submission officer read", () => {
  it("counts only a reviewed section with text as drafted (complete)", () => {
    const out = proposalFromSections([
      section({ section_key: "a", position: 0, status: "REVIEWED" }),
      section({ section_key: "b", position: 1, status: "DRAFT", needs: ["Verified staff list"] }),
      section({ section_key: "c", position: 2, status: "MISSING_INFORMATION", content: null, needs: ["References"] }),
    ]);
    expect(out.sections.map((s) => [s.key, s.status])).toEqual([
      ["a", "DRAFTED"],
      ["b", "REQUIRES_CONFIRMATION"],
      ["c", "MISSING_INFORMATION"],
    ]);
    expect(out.open_items).toBe(2);
    expect(proposalOutputSchema.safeParse(out).success).toBe(true);
  });

  it("never lets a reviewed section with no text count as complete", () => {
    const out = proposalFromSections([section({ status: "REVIEWED", content: "  " })]);
    expect(out.sections[0].status).toBe("MISSING_INFORMATION");
  });

  it("carries the person's text and drops the AI's list of what was needed once a person reviewed it", () => {
    const out = proposalFromSections([section({ content: "Our own text.", needs: ["Something"], status: "REVIEWED" })]);
    expect(out.sections[0]).toMatchObject({ content: "Our own text.", needs: [] });
  });

  it("orders by position, is never simulated, and says when AI text is in it", () => {
    const out = proposalFromSections([section({ section_key: "b", position: 1, ai_generated: true }), section({ section_key: "a", position: 0 })]);
    expect(out.sections.map((s) => s.key)).toEqual(["a", "b"]);
    expect(out).toMatchObject({ simulated: false, ai_generated: true });
  });

  it("makes QA's technical check pass only when every section was reviewed", () => {
    const prior = (rows: BidSectionRow[]) => ({ proposal: proposalFromSections(rows) });
    const closing = { closing_at: new Date(Date.now() + 5 * 86_400_000).toISOString() };
    const technical = (rows: BidSectionRow[]) => reviewBid(closing, prior(rows), new Date()).checks.find((c) => c.key === "technical")!.result;
    expect(technical([section({ status: "DRAFT" })])).toBe("OPEN_ISSUE");
    expect(technical([section({ status: "REVIEWED" })])).toBe("PASS");
  });

  it("changes the approved pack's hash when a person changes the text or a figure, so the hash covers what was written", () => {
    const hash = (rows: BidSectionRow[], cents: number | null) =>
      packageHash({ proposal: proposalFromSections(rows), pricing: pricingFromRows(bid({ confirmed: true }), [line({ unit_price_cents: cents })]) });
    const base = hash([section({ content: "One." })], 100);
    expect(hash([section({ content: "One." })], 100)).toBe(base);
    expect(hash([section({ content: "Two." })], 100)).not.toBe(base);
    expect(hash([section({ content: "One." })], 101)).not.toBe(base);
  });

  it("is evidence for QA's coverage rule only when it is complete", () => {
    const evidence = buildEvidence({
      proposal: proposalFromSections([section({ section_key: "done", status: "REVIEWED" }), section({ section_key: "todo", status: "DRAFT" })]),
    });
    expect(evidence.get("section:done")).toEqual({ complete: true, state: "DRAFTED" });
    expect(evidence.get("section:todo")).toMatchObject({ complete: false, state: "REQUIRES_CONFIRMATION" });
  });
});

const bid = (over: Partial<BidPricingRow> = {}): BidPricingRow => ({
  vat_treatment: "NOT_STATED",
  vat_status: "REQUIRES_CONFIRMATION",
  vat_requirement_id: null,
  notes: ["Final pricing requires human approval"],
  ai_generated: true,
  confirmed: false,
  ...over,
});

const line = (over: Partial<BidPricingLineRow> = {}): BidPricingLineRow => ({
  id: "l1",
  position: 0,
  source: "TENDER",
  description: "Supply 110 mm pipe",
  item_ref: "1.1",
  quantity: "500",
  quantity_printed: true,
  unit: "m",
  unit_price_cents: null,
  supplier_quote_ref: null,
  supplier_quote_likely: true,
  requirement_id: "doc-3",
  quote: "1.1 Supply 110 mm pipe 500 m",
  page: 4,
  warning: null,
  ...over,
});

describe("pricingFromRows: the schedule as QA and the submission officer read it", () => {
  it("is unconfirmed until a person has priced every line and confirmed", () => {
    const out = pricingFromRows(bid(), [line()]);
    expect(out).toMatchObject({ status: "REQUIRES_CONFIRMATION", subtotal_zar: null, requires_human_approval: true, currency: "ZAR", simulated: false });
    expect(out.lines[0]).toMatchObject({ unit_price_zar: null, source: "MISSING_INFORMATION", quantity: 500, unit: "m", requirement_id: "doc-3", page: 4 });
    expect(pricingOutputSchema.safeParse(out).success).toBe(true);
  });

  it("stays unconfirmed when the figures are all in but nobody confirmed", () => {
    expect(pricingFromRows(bid({ confirmed: false }), [line({ unit_price_cents: 12000 })]).status).toBe("REQUIRES_CONFIRMATION");
  });

  it("is ready for approval only when priced, complete and confirmed", () => {
    const out = pricingFromRows(bid({ confirmed: true }), [
      line({ unit_price_cents: 12000, supplier_quote_ref: "Q-77" }),
      line({ id: "l2", position: 1, unit_price_cents: 0 }),
    ]);
    expect(out.status).toBe("READY_FOR_APPROVAL");
    expect(out.subtotal_zar).toBe(60000);
    expect(out.lines[0]).toMatchObject({ unit_price_zar: 120, source: "SUPPLIER_QUOTE" });
    expect(out.lines[1]).toMatchObject({ unit_price_zar: 0, source: "RATE_CARD" });
  });

  it("is not ready if a confirmed bid has a line that lost its price, or no lines", () => {
    expect(pricingFromRows(bid({ confirmed: true }), [line({ unit_price_cents: 100 }), line({ id: "l2", unit_price_cents: null })]).status).toBe(
      "REQUIRES_CONFIRMATION",
    );
    expect(pricingFromRows(bid({ confirmed: true }), []).status).toBe("REQUIRES_CONFIRMATION");
    expect(pricingFromRows(bid({ confirmed: true }), [line({ unit_price_cents: 100, quantity: null })]).status).toBe("REQUIRES_CONFIRMATION");
  });

  it("keeps the VAT treatment the tender states, and the notes", () => {
    const out = pricingFromRows(bid({ vat_treatment: "EXCLUSIVE", vat_status: "STATED", vat_requirement_id: "doc-9", notes: ["Note one"] }), []);
    expect(out.vat).toEqual({ rate: 0.15, treatment: "EXCLUSIVE", status: "STATED", requirement_id: "doc-9" });
    expect(out.vat_rate).toBe(0.15);
    expect(out.notes).toEqual(["Note one"]);
  });

  it("makes QA's pricing check and coverage evidence follow the person's confirmation", () => {
    const closing = { closing_at: new Date(Date.now() + 5 * 86_400_000).toISOString() };
    const pricingCheck = (rows: BidPricingLineRow[], confirmed: boolean) =>
      reviewBid(closing, { pricing: pricingFromRows(bid({ confirmed }), rows) }, new Date()).checks.find((c) => c.key === "pricing")!.result;
    expect(pricingCheck([line({ unit_price_cents: 100 })], false)).toBe("OPEN_ISSUE");
    expect(pricingCheck([line({ unit_price_cents: 100 })], true)).toBe("PASS");
    const evidence = buildEvidence({ pricing: pricingFromRows(bid({ confirmed: true }), [line({ unit_price_cents: 100 })]) });
    expect(evidence.get("pricing:doc-3")).toEqual({ complete: true, state: "READY_FOR_APPROVAL" });
  });

  it("shows a person's own line with no requirement as an ordinary line", () => {
    const out = pricingFromRows(bid({ confirmed: true }), [
      line({ source: "PERSON", requirement_id: null, quote: null, page: null, quantity_printed: false, unit_price_cents: 500 }),
    ]);
    expect(out.lines[0].requirement_id).toBeUndefined();
    expect(out.lines[0]).toMatchObject({ description: "Supply 110 mm pipe", unit_price_zar: 5 });
  });
});
