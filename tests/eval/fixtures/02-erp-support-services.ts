import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-erp";
const L = {
  title: "REQUEST FOR BIDS: ERP SYSTEM SUPPORT AND MAINTENANCE SERVICES FOR 36 MONTHS, BID NO. MPT/ICT/2026/07",
  intro: "The Mpumalanga Provincial Treasury invites bids for the support and maintenance of its enterprise resource planning system.",
  closing: "Bids must be submitted electronically on the eTender portal before 12:00 on 30 October 2026.",
  period: "The contract period is 36 months from the date of signature by both parties.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD) at the time of bid closing.",
  iso: "Bidders must submit a valid ISO/IEC 27001 certificate for the service delivery centre.",
  threshold: "Bidders must score a minimum of 70 out of 100 points for functionality to qualify for price and preference evaluation.",
  evaluation: "Bids that meet the functionality threshold will be evaluated on the 80/20 preference point system.",
  sla: "The service provider must respond to critical incidents within one hour and resolve them within four hours.",
  popia: "The successful bidder must enter into an operator agreement in terms of the Protection of Personal Information Act, 2013 (POPIA).",
  pricing: "The pricing schedule must show a fixed monthly fee and an hourly rate for work outside the scope of the monthly fee.",
  vat: "All prices must be inclusive of value-added tax (VAT).",
  declaration: "Bidders must complete and sign the Standard Bidding Documents SBD 1, SBD 4 and SBD 6.1.",
};

export const erpSupportServices: EvalFixture = {
  id: "erp-support-services",
  title: "Provincial ERP support and maintenance, ICT",
  description: "IT services bid with a functionality threshold, ISO certificate, POPIA operator agreement and an SLA.",
  tags: ["sector:it"],
  tender: {
    reference_number: "MPT/ICT/2026/07",
    title: "ERP system support and maintenance services",
    issuing_organisation: "Mpumalanga Provincial Treasury",
    province: "MPUMALANGA",
    sector: "ICT services",
    estimated_value_zar: 8_200_000,
    closing_at: "2026-10-30T10:00:00.000Z",
    submission_method: "ELECTRONIC_PORTAL",
  },
  documents: [
    {
      id: D,
      title: "Bid document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.period) },
        { page: 2, text: page(L.csd, L.iso, L.threshold, L.evaluation, L.declaration) },
        { page: 3, text: page(L.sla, L.popia, L.pricing, L.vat) },
      ],
    },
  ],
  company: "it",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["30 October 2026", "closing", "electronic"], {
        date: { kind: "CLOSING", iso: "2026-10-30T12:00:00+02:00" },
      }),
      expectReq(D, "period", "SCOPE", true, L.period, 1, ["36 months"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "iso", "DOCUMENT", true, L.iso, 2, ["ISO"]),
      expectReq(D, "threshold", "EVALUATION", true, L.threshold, 2, ["70 out of 100", "functionality"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 2, ["80/20"]),
      expectReq(D, "sbd", "DOCUMENT", true, L.declaration, 2, ["SBD"]),
      expectReq(D, "sla", "MANDATORY_CONDITION", true, L.sla, 3, ["one hour", "four hours", "critical"]),
      expectReq(D, "popia", "MANDATORY_CONDITION", true, L.popia, 3, ["POPIA", "operator agreement"]),
      expectReq(D, "pricing", "PRICING", true, L.pricing, 3, ["monthly fee", "hourly rate"]),
      expectReq(D, "vat", "PRICING", true, L.vat, 3, ["VAT", "inclusive"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
