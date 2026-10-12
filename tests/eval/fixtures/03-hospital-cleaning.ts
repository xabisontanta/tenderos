import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-cleaning";
const L = {
  title: "BID DOCUMENT: CLEANING AND HYGIENE SERVICES FOR MTHATHA DISTRICT HOSPITAL, BID NO. ECDOH/MTH/2026/31",
  intro: "The Eastern Cape Department of Health invites bids for cleaning and hygiene services at Mthatha District Hospital for 24 months.",
  closing: "Sealed bids must be deposited in the bid box at the Mthatha District Hospital reception before 10:00 on 3 November 2026.",
  inspection: "A site inspection will be held at the hospital on 19 October 2026 at 09:00; attendance is not compulsory.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD).",
  coida: "Bidders must attach a valid COIDA letter of good standing.",
  wage: "Bidders must pay cleaners not less than the national minimum wage prescribed under the National Minimum Wage Act, 2018.",
  references: "Bidders must submit three reference letters for cleaning contracts of similar size completed in the last three years.",
  chemicals: "Safety data sheets must be provided for every cleaning chemical the bidder intends to use.",
  evaluation: "Bids will be evaluated on the 80/20 preference point system.",
  pricing: "Bidders must quote a monthly fee for the hospital as a whole, inclusive of VAT, consumables and equipment.",
  payment: "The Department will pay valid invoices within 30 days of receipt.",
};

export const hospitalCleaning: EvalFixture = {
  id: "hospital-cleaning",
  title: "District hospital cleaning and hygiene services",
  description: "Facilities tender with a non-compulsory inspection, minimum wage condition, references and chemical safety data sheets.",
  tags: ["sector:cleaning"],
  tender: {
    reference_number: "ECDOH/MTH/2026/31",
    title: "Cleaning and hygiene services, Mthatha District Hospital",
    issuing_organisation: "Eastern Cape Department of Health",
    province: "EASTERN_CAPE",
    sector: "Cleaning",
    estimated_value_zar: 5_600_000,
    closing_at: "2026-11-03T08:00:00.000Z",
    briefing_at: "2026-10-19T07:00:00.000Z",
    briefing_compulsory: false,
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Bid document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.inspection) },
        { page: 2, text: page(L.csd, L.coida, L.wage, L.references, L.chemicals) },
        { page: 3, text: page(L.evaluation, L.pricing, L.payment) },
      ],
    },
  ],
  company: "facilities",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["3 November 2026", "closing"], { date: { kind: "CLOSING", iso: "2026-11-03T10:00:00+02:00" } }),
      expectReq(D, "inspection", "BRIEFING", false, L.inspection, 1, ["site inspection", "not compulsory"], { date: { kind: "BRIEFING", iso: "2026-10-19T09:00:00+02:00" } }),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "coida", "DOCUMENT", true, L.coida, 2, ["COIDA"]),
      expectReq(D, "wage", "MANDATORY_CONDITION", true, L.wage, 2, ["minimum wage"]),
      expectReq(D, "references", "DOCUMENT", true, L.references, 2, ["reference letters", "three"]),
      expectReq(D, "sds", "DOCUMENT", true, L.chemicals, 2, ["safety data sheets"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["80/20"]),
      expectReq(D, "pricing", "PRICING", true, L.pricing, 3, ["monthly fee", "VAT"]),
      expectReq(D, "payment", "PRICING", false, L.payment, 3, ["30 days"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
