import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-lights";
const L = {
  title: "TENDER BCMM/ELEC/2026/03: MAINTENANCE OF STREETLIGHTS AND HIGH-MAST LIGHTING FOR 36 MONTHS",
  intro: "The Buffalo City Metropolitan Municipality invites tenders for the routine and emergency maintenance of streetlights and high-mast lighting.",
  closing: "Tenders must be submitted before 11:00 on 2 November 2026 through the municipality's eTender portal.",
  visit: "An optional site visit will be held at the Electricity Department depot on 14 October 2026 at 09:00.",
  cidb: "Tenderers must hold a valid CIDB grading of 4EP or higher.",
  registered: "The tenderer must be a registered electrical contractor with the Department of Employment and Labour.",
  engineer: "A professionally registered electrical engineering technologist with ECSA must be nominated as the responsible person.",
  response: "Reported faults on high-mast lights must be attended to within four hours of the fault being logged.",
  csd: "Tenderers must be registered on the Central Supplier Database (CSD).",
  evaluation: "Tenders will be evaluated on the 80/20 preference point system.",
  schedule: "The pricing schedule must contain a monthly fee for routine maintenance and a rate list for repairs.",
  vat: "Prices must be quoted exclusive of VAT.",
};

export const streetlightMaintenance: EvalFixture = {
  id: "streetlight-maintenance",
  title: "Streetlight and high-mast maintenance, CIDB 4EP",
  description: "Electrical maintenance tender with an optional site visit, a registered-contractor condition and a response-time requirement.",
  tags: ["sector:electrical", "sector:municipal", "sector:construction"],
  tender: {
    reference_number: "BCMM/ELEC/2026/03",
    title: "Maintenance of streetlights and high-mast lighting",
    issuing_organisation: "Buffalo City Metropolitan Municipality",
    province: "EASTERN_CAPE",
    sector: "Construction",
    estimated_value_zar: 12_000_000,
    closing_at: "2026-11-02T09:00:00.000Z",
    briefing_at: "2026-10-14T07:00:00.000Z",
    briefing_compulsory: false,
    submission_method: "ELECTRONIC_PORTAL",
  },
  documents: [
    {
      id: D,
      title: "Tender document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.visit) },
        { page: 2, text: page(L.cidb, L.registered, L.engineer, L.response, L.csd) },
        { page: 3, text: page(L.evaluation, L.schedule, L.vat) },
      ],
    },
  ],
  company: "civils",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["2 November 2026", "eTender"], { date: { kind: "CLOSING", iso: "2026-11-02T11:00:00+02:00" } }),
      expectReq(D, "visit", "BRIEFING", false, L.visit, 1, ["site visit", "optional"], { date: { kind: "BRIEFING", iso: "2026-10-14T09:00:00+02:00" } }),
      expectReq(D, "cidb", "MANDATORY_CONDITION", true, L.cidb, 2, ["CIDB", "4EP"]),
      expectReq(D, "registered", "MANDATORY_CONDITION", true, L.registered, 2, ["registered electrical contractor"]),
      expectReq(D, "engineer", "MANDATORY_CONDITION", true, L.engineer, 2, ["ECSA", "responsible person"]),
      expectReq(D, "response", "SCOPE", true, L.response, 2, ["four hours"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["80/20"]),
      expectReq(D, "schedule", "PRICING", true, L.schedule, 3, ["monthly fee", "rate list"]),
      expectReq(D, "vat", "PRICING", true, L.vat, 3, ["VAT", "exclusive"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
