import { describe, expect, it } from "vitest";
import type { TenderSnapshot } from "@/agents/runtime/types";
import { assessQualification, MIN_PREPARATION_HOURS } from "@/agents/qualification/logic";
import { evaluateCompliance, isComplete } from "@/agents/compliance/logic";
import { reviewBid } from "@/agents/qa/logic";
import { subtotal, withVat } from "@/agents/pricing/logic";
import { packageHash, stableStringify } from "@/agents/submission/logic";
import { extractRecordRequirements } from "@/agents/analysis/logic";

const NOW = new Date("2026-10-10T10:00:00Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const tender = (o: Partial<TenderSnapshot> = {}): TenderSnapshot => ({
  id: "00000000-0000-0000-0000-000000000001",
  reference_number: "RFQ-1",
  title: "Test",
  issuing_organisation: "Test Municipality",
  description: null,
  province: "GAUTENG",
  sector: null,
  estimated_value_zar: null,
  published_at: null,
  closing_at: inDays(14),
  briefing_at: null,
  briefing_compulsory: false,
  briefing_location: null,
  questions_deadline_at: null,
  submission_method: "ELECTRONIC_PORTAL",
  submission_destination: null,
  source_url: null,
  is_simulation: true,
  ...o,
});

describe("qualification", () => {
  it("qualifies but requires confirmation when the company profile is unknown", () => {
    const r = assessQualification(tender(), NOW, null);
    expect(r.decision).toBe("QUALIFIED");
    expect(r.confirmation_required).toBe(true);
    expect(r.factors.filter((f) => f.result === "REQUIRES_CONFIRMATION").map((f) => f.key)).toEqual(
      expect.arrayContaining(["capability", "geography", "financial", "experience"]),
    );
  });

  it("rejects a closed tender regardless of score", () => {
    const r = assessQualification(tender({ closing_at: inDays(-1) }), NOW, null);
    expect(r.decision).toBe("REJECTED");
    expect(r.hard_disqualifiers[0]).toMatch(/Closing date/);
  });

  it(`rejects with less than ${MIN_PREPARATION_HOURS}h to prepare`, () => {
    expect(assessQualification(tender({ closing_at: inDays(1) }), NOW, null).decision).toBe("REJECTED");
  });

  it("rejects when a compulsory briefing was missed", () => {
    const r = assessQualification(tender({ briefing_compulsory: true, briefing_at: inDays(-2) }), NOW, null);
    expect(r.decision).toBe("REJECTED");
  });

  it("a high fit score does not override a hard disqualifier", () => {
    const company = { provinces: ["GAUTENG"], sectors: ["furniture"], maxContractValueZar: 100_000 };
    const r = assessQualification(tender({ sector: "Furniture", estimated_value_zar: 5_000_000 }), NOW, company);
    expect(r.fit_score).toBeGreaterThanOrEqual(50);
    expect(r.decision).toBe("REJECTED");
    expect(r.hard_disqualifiers.join()).toMatch(/exposure limit/);
  });

  it("every factor carries evidence", () => {
    for (const f of assessQualification(tender({ briefing_compulsory: true }), NOW, null).factors) expect(f.evidence.length).toBeGreaterThan(0);
  });
});

describe("compliance", () => {
  it("never reports documents as valid without a vault", () => {
    const items = evaluateCompliance(tender(), null, NOW);
    expect(items.every((i) => i.status === "MISSING_INFORMATION")).toBe(true);
    expect(isComplete(items)).toBe(false);
  });

  it("adds CIDB grading for construction tenders", () => {
    expect(evaluateCompliance(tender({ sector: "Civil construction" }), null, NOW).map((i) => i.key)).toContain("cidb_grading");
  });

  it("flags documents that expire before closing and unverified documents", () => {
    const vault = [
      { type: "cipc_registration", expiresAt: null, verified: true },
      { type: "csd_registration", expiresAt: inDays(5), verified: true },
      { type: "tax_compliance", expiresAt: inDays(200), verified: false },
      { type: "sbd_declarations", expiresAt: null, verified: true },
    ];
    const byKey = Object.fromEntries(evaluateCompliance(tender(), vault, NOW).map((i) => [i.key, i.status]));
    expect(byKey).toMatchObject({
      cipc_registration: "VALID",
      csd_registration: "EXPIRED",
      tax_compliance: "REQUIRES_CONFIRMATION",
      bbbee: "MISSING_INFORMATION",
    });
  });
});

describe("QA", () => {
  const prior = {
    intake: {},
    analysis: {},
    qualification: { decision: "QUALIFIED" },
    compliance: { missing: [] },
    proposal: { open_items: 0 },
    pricing: { status: "READY_FOR_APPROVAL" },
  };

  it("passes a complete bid", () => {
    expect(reviewBid(tender(), prior, NOW).verdict).toBe("PASS");
  });

  it("is conditional when issues remain", () => {
    const r = reviewBid(tender(), { ...prior, compliance: { missing: ["CSD"] } }, NOW);
    expect(r.verdict).toBe("CONDITIONAL");
    expect(r.open_issues[0]).toMatch(/CSD/);
  });

  it("fails when the deadline passed or a step is missing", () => {
    expect(reviewBid(tender({ closing_at: inDays(-1) }), prior, NOW).verdict).toBe("FAIL");
    const { pricing: _p, ...noPricing } = prior;
    expect(reviewBid(tender(), noPricing, NOW).verdict).toBe("FAIL");
  });
});

describe("pricing arithmetic", () => {
  it("returns null subtotal when any line is unconfirmed", () => {
    expect(subtotal([{ description: "x", quantity: 2, unit: "ea", unit_price_zar: null, source: "MISSING_INFORMATION" }])).toBeNull();
  });
  it("sums lines and applies 15% VAT", () => {
    const s = subtotal([
      { description: "a", quantity: 2, unit: "ea", unit_price_zar: 100.1, source: "SUPPLIER_QUOTE" },
      { description: "b", quantity: 1, unit: "ea", unit_price_zar: 50, source: "RATE_CARD" },
    ]);
    expect(s).toBe(250.2);
    expect(withVat(s!)).toBe(287.73);
  });
});

describe("submission package hash", () => {
  it("is stable regardless of key order", () => {
    expect(packageHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(packageHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(stableStringify({ b: 1, a: undefined })).toBe('{"b":1}');
  });
  it("changes when content changes", () => {
    expect(packageHash({ a: 1 })).not.toBe(packageHash({ a: 2 }));
  });
});

describe("requirement extraction", () => {
  it("cites the record field for every requirement and reports document gaps", () => {
    const r = extractRecordRequirements(tender({ briefing_compulsory: true }));
    expect(r.requirements.every((x) => x.source.kind === "TENDER_RECORD" && x.source.field)).toBe(true);
    expect(r.requirements.find((x) => x.id === "briefing")!.status).toBe("MISSING_INFORMATION");
    expect(r.gaps.join()).toMatch(/No tender documents/);
  });
});
