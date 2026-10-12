import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-gloves";
const L = {
  title: "BID GDH/MED/2026/118: SUPPLY AND DELIVERY OF NON-STERILE EXAMINATION GLOVES FOR 24 MONTHS",
  intro: "The Gauteng Department of Health invites bids for the supply and delivery of non-sterile examination gloves to its medical supply depots.",
  closing: "Bids must be submitted in the bid box at the Medical Supplies Depot, Johannesburg, before 11:00 on 6 November 2026.",
  samples: "Samples of each item bid for must be delivered to the Medical Supplies Depot by 12:00 on 20 October 2026.",
  sampleDq: "Bids that are not accompanied by samples will be disqualified.",
  sahpra: "Bidders must submit a valid South African Health Products Regulatory Authority (SAHPRA) licence to manufacture, import, distribute or wholesale medical devices.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD) and have a valid SARS Tax Compliance Status.",
  evaluation: "Bids will be evaluated on the 90/10 preference point system.",
  delivery: "Delivery must be made within 14 days of receipt of an official order.",
  firm: "Prices must remain firm for the first 12 months of the contract.",
  pricing: "Bidders must quote a price per box of 100 gloves, inclusive of VAT and delivery to the depot.",
  quality: "Gloves must comply with SANS 1488 and be supplied with a certificate of conformity for each batch.",
};

export const medicalExaminationGloves: EvalFixture = {
  id: "medical-examination-gloves",
  title: "Examination gloves supply, SAHPRA licence and samples",
  description: "Medical supplies bid above R50 million: 90/10, mandatory samples, SAHPRA licence, firm prices.",
  tags: ["sector:medical"],
  tender: {
    reference_number: "GDH/MED/2026/118",
    title: "Supply and delivery of non-sterile examination gloves",
    issuing_organisation: "Gauteng Department of Health",
    province: "GAUTENG",
    sector: "Medical supplies",
    estimated_value_zar: 62_000_000,
    closing_at: "2026-11-06T09:00:00.000Z",
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Bid document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.samples, L.sampleDq) },
        { page: 2, text: page(L.sahpra, L.csd, L.evaluation, L.quality) },
        { page: 3, text: page(L.delivery, L.firm, L.pricing) },
      ],
    },
  ],
  company: "medical",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["6 November 2026", "closing"], { date: { kind: "CLOSING", iso: "2026-11-06T11:00:00+02:00" } }),
      expectReq(D, "samples", "DOCUMENT", true, L.samples, 1, ["samples"]),
      expectReq(D, "sample-dq", "MANDATORY_CONDITION", true, L.sampleDq, 1, ["disqualified", "samples"]),
      expectReq(D, "sahpra", "DOCUMENT", true, L.sahpra, 2, ["SAHPRA"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 2, ["90/10"]),
      expectReq(D, "quality", "MANDATORY_CONDITION", true, L.quality, 2, ["SANS 1488", "certificate of conformity"]),
      expectReq(D, "delivery", "SCOPE", true, L.delivery, 3, ["14 days"]),
      expectReq(D, "firm", "PRICING", true, L.firm, 3, ["firm", "12 months"]),
      expectReq(D, "pricing", "PRICING", true, L.pricing, 3, ["per box", "VAT"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
