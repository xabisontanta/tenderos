import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-security";
const L = {
  title: "TENDER NO. UMH/SCM/2026/22: PROVISION OF SECURITY GUARDING SERVICES AT MUNICIPAL BUILDINGS FOR 36 MONTHS",
  intro: "The uMhlathuze Local Municipality invites tenders for 24-hour armed and unarmed guarding services at 14 municipal buildings.",
  closing: "Tenders close at 11:00 on 5 November 2026 and must be placed in the tender box at the Civic Centre, Richards Bay.",
  briefing: "A compulsory briefing will be held at the Civic Centre on 15 October 2026 at 11:00.",
  psira: "Bidders must be registered with the Private Security Industry Regulatory Authority (PSIRA) and submit a valid certificate of registration.",
  grade: "The company and all guards deployed must hold PSIRA Grade C registration as a minimum.",
  control: "The successful bidder must operate a 24-hour control room with radio communication to all sites.",
  coida: "A valid COIDA letter of good standing must be submitted.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD).",
  evaluation: "Tenders will be evaluated on the 90/10 preference point system.",
  pricing: "Tenderers must quote a monthly rate per guard post, exclusive of VAT, for each category of post.",
  wage: "Guards must be remunerated at not less than the sectoral determination for the private security sector.",
};

export const municipalSecurityGuarding: EvalFixture = {
  id: "municipal-security-guarding",
  title: "Municipal security guarding, PSIRA Grade C",
  description: "Security services tender at a value above the bidder's exposure limit: the rule gate must reject it whatever the AI says.",
  tags: ["sector:security", "sector:municipal"],
  tender: {
    reference_number: "UMH/SCM/2026/22",
    title: "Provision of security guarding services at municipal buildings",
    issuing_organisation: "uMhlathuze Local Municipality",
    province: "KWAZULU_NATAL",
    sector: "Security services",
    estimated_value_zar: 61_000_000,
    closing_at: "2026-11-05T09:00:00.000Z",
    briefing_at: "2026-10-15T09:00:00.000Z",
    briefing_compulsory: true,
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Tender document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.briefing) },
        { page: 2, text: page(L.psira, L.grade, L.control, L.coida, L.csd) },
        { page: 3, text: page(L.evaluation, L.pricing, L.wage) },
      ],
    },
  ],
  company: "facilities",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["5 November 2026", "close"], { date: { kind: "CLOSING", iso: "2026-11-05T11:00:00+02:00" } }),
      expectReq(D, "briefing", "BRIEFING", true, L.briefing, 1, ["compulsory briefing"], { date: { kind: "BRIEFING", iso: "2026-10-15T11:00:00+02:00" } }),
      expectReq(D, "psira", "DOCUMENT", true, L.psira, 2, ["PSIRA"]),
      expectReq(D, "grade", "MANDATORY_CONDITION", true, L.grade, 2, ["Grade C"]),
      expectReq(D, "control", "MANDATORY_CONDITION", true, L.control, 2, ["control room", "24-hour"]),
      expectReq(D, "coida", "DOCUMENT", true, L.coida, 2, ["COIDA"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["90/10"]),
      expectReq(D, "pricing", "PRICING", true, L.pricing, 3, ["monthly rate", "guard post"]),
      expectReq(D, "wage", "MANDATORY_CONDITION", true, L.wage, 3, ["sectoral determination", "remunerated"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "REJECTED" },
  },
};
