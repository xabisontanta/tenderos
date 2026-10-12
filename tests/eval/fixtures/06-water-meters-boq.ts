import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-meters";
const L = {
  title: "TENDER MBM/TECH/2026/09: SUPPLY, DELIVERY AND INSTALLATION OF 2 000 SMART PREPAID WATER METERS",
  intro:
    "The Mbombela Local Municipality invites tenders for the supply and installation of smart prepaid water meters in the Nelspruit and Kanyamazane supply areas.",
  closing: "Tenders must be submitted on the eTender portal before 12:00 on 4 November 2026.",
  briefing: "A non-compulsory information session will be held on 16 October 2026 at 10:00 at the Technical Services boardroom.",
  csd: "Tenderers must be registered on the Central Supplier Database (CSD).",
  nrcs: "Meters must carry a valid National Regulator for Compulsory Specifications (NRCS) approval.",
  warranty: "The tenderer must provide a warranty of at least 24 months on all meters supplied.",
  evaluation: "Tenders will be evaluated on the 80/20 preference point system.",
  boq1: "1.1 Supply of 15 mm smart prepaid water meter (each) 2 000",
  boq2: "1.2 Installation of water meter including couplings and valve box (each) 2 000",
  boq3: "1.3 Commissioning and registration on the municipal billing system (sum) 1",
  boq4: "1.4 Training of municipal technicians (sum) 1",
  vat: "All rates and prices must be quoted exclusive of VAT.",
  completion: "The works must be completed within 16 weeks of the date of the written order.",
};

export const waterMetersBoq: EvalFixture = {
  id: "water-meters-boq",
  title: "Smart water meters with a bill of quantities",
  description:
    "Municipal supply-and-install tender with four BOQ lines and a VAT instruction: the pricing agent must structure the lines and leave every rate empty.",
  tags: ["sector:municipal", "sector:electrical"],
  tender: {
    reference_number: "MBM/TECH/2026/09",
    title: "Supply, delivery and installation of smart prepaid water meters",
    issuing_organisation: "Mbombela Local Municipality",
    province: "MPUMALANGA",
    sector: "Construction",
    estimated_value_zar: 9_400_000,
    closing_at: "2026-11-04T10:00:00.000Z",
    briefing_at: "2026-10-16T08:00:00.000Z",
    briefing_compulsory: false,
    submission_method: "ELECTRONIC_PORTAL",
  },
  documents: [
    {
      id: D,
      title: "Tender document and bill of quantities",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.briefing, L.csd) },
        { page: 2, text: page(L.nrcs, L.warranty, L.evaluation, L.completion) },
        { page: 3, text: page("BILL OF QUANTITIES", L.boq1, L.boq2, L.boq3, L.boq4, L.vat) },
      ],
    },
  ],
  company: "civils",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["4 November 2026", "eTender"], { date: { kind: "CLOSING", iso: "2026-11-04T12:00:00+02:00" } }),
      expectReq(D, "session", "BRIEFING", false, L.briefing, 1, ["information session", "non-compulsory"], {
        date: { kind: "BRIEFING", iso: "2026-10-16T10:00:00+02:00" },
      }),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 1, ["CSD", "Central Supplier Database"]),
      expectReq(D, "nrcs", "DOCUMENT", true, L.nrcs, 2, ["NRCS"]),
      expectReq(D, "warranty", "MANDATORY_CONDITION", true, L.warranty, 2, ["24 months", "warranty"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 2, ["80/20"]),
      expectReq(D, "completion", "SCOPE", true, L.completion, 2, ["16 weeks"]),
      expectReq(D, "boq-1", "PRICING", true, L.boq1, 3, ["smart prepaid water meter", "Supply"]),
      expectReq(D, "boq-2", "PRICING", true, L.boq2, 3, ["Installation"]),
      expectReq(D, "boq-3", "PRICING", true, L.boq3, 3, ["Commissioning"]),
      expectReq(D, "boq-4", "PRICING", true, L.boq4, 3, ["Training"]),
      expectReq(D, "vat", "PRICING", true, L.vat, 3, ["VAT", "exclusive"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
