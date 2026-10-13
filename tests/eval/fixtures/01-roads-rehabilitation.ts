import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-roads";
const L = {
  title: "INVITATION TO BID: REHABILITATION OF ACCESS ROADS IN WARD 12, TENDER NO. LM/ENG/2026/014",
  intro: "The Lephalale Local Municipality invites contractors to submit bids for the rehabilitation of 6,4 km of surfaced access roads in Ward 12.",
  closing: "Bids must be deposited in the tender box at the Civic Centre, Lephalale, before 11:00 on 28 October 2026.",
  late: "Late bids will not be considered and will be returned unopened.",
  briefing: "A compulsory site briefing session will be held at the Ward 12 community hall on 14 October 2026 at 10:00.",
  attendance: "Bidders who do not attend the compulsory briefing and sign the attendance register will be disqualified.",
  cidb: "Bidders must hold a valid CIDB grading of 6CE or higher at the time of bid submission.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD) and provide the CSD summary report.",
  tax: "A valid SARS Tax Compliance Status (TCS) PIN must be provided with the bid.",
  forms: "The following returnable documents must be completed and submitted with the bid: MBD 1, MBD 4, MBD 6.1, MBD 8 and MBD 9.",
  coida: "A valid letter of good standing from the Compensation Fund (COIDA) must be attached.",
  evaluation: "Bids will be evaluated on the 80/20 preference point system, with 80 points for price and 20 points for B-BBEE status level of contribution.",
  vat: "Prices must be quoted in South African Rand and must be exclusive of value-added tax (VAT).",
  validity: "Bids shall remain valid for 90 days after the closing date.",
};

export const roadsRehabilitation: EvalFixture = {
  id: "roads-rehabilitation",
  title: "Municipal roads rehabilitation, CIDB 6CE",
  description: "A plain, well-formed municipal construction tender: compulsory briefing, CIDB grading, MBD returnables, 80/20.",
  tags: ["sector:construction", "sector:municipal"],
  tender: {
    reference_number: "LM/ENG/2026/014",
    title: "Rehabilitation of access roads in Ward 12",
    issuing_organisation: "Lephalale Local Municipality",
    province: "LIMPOPO",
    sector: "Construction",
    estimated_value_zar: 14_500_000,
    closing_at: "2026-10-28T09:00:00.000Z",
    briefing_at: "2026-10-14T08:00:00.000Z",
    briefing_compulsory: true,
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Invitation to bid and conditions of tender",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.late) },
        { page: 2, text: page(L.briefing, L.attendance, L.cidb, L.csd, L.tax) },
        { page: 3, text: page(L.forms, L.coida, L.evaluation, L.vat, L.validity) },
      ],
    },
  ],
  company: "civils",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["closing", "28 October 2026"], { date: { kind: "CLOSING", iso: "2026-10-28T11:00:00+02:00" } }),
      expectReq(D, "briefing", "BRIEFING", true, L.briefing, 2, ["briefing"], { date: { kind: "BRIEFING", iso: "2026-10-14T10:00:00+02:00" } }),
      expectReq(D, "attendance", "MANDATORY_CONDITION", true, L.attendance, 2, ["disqualified", "attendance"]),
      expectReq(D, "cidb", "MANDATORY_CONDITION", true, L.cidb, 2, ["CIDB"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "tcs", "DOCUMENT", true, L.tax, 2, ["Tax Compliance", "TCS"]),
      expectReq(D, "forms", "DOCUMENT", true, L.forms, 3, ["MBD"]),
      expectReq(D, "coida", "DOCUMENT", true, L.coida, 3, ["COIDA", "Compensation Fund"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["80/20", "preference"]),
      expectReq(D, "vat", "PRICING", true, L.vat, 3, ["VAT", "exclusive"]),
    ],
    forbidden: [{ pattern: "\\bdeposit\\b|refundable", why: "The documents ask for no deposit" }],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
