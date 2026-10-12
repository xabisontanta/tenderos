import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-nutrition";
const L = {
  title: "BID ECDOE/NSNP/2026/05: PROVISION OF COOKED MEALS TO LEARNERS IN THE MBIZANA CIRCUIT FOR 24 MONTHS",
  intro: "The Eastern Cape Department of Education invites bids for the preparation and delivery of cooked meals to 38 quintile 1 to 3 schools under the National School Nutrition Programme.",
  closing: "Bids must be placed in the bid box at the district office, Mbizana, before 11:00 on 29 October 2026.",
  briefing: "A compulsory briefing will be held at the district office on 13 October 2026 at 10:00.",
  coa: "Bidders must submit a valid Certificate of Acceptability for food premises issued by the municipal health services.",
  medical: "Bidders must provide valid medical certificates of fitness for every food handler.",
  menu: "Bidders must submit a menu that complies with the National School Nutrition Programme guidelines.",
  local: "At least 30% of the food handlers employed on the contract must be recruited from the local community.",
  csd: "Bidders must be registered on the Central Supplier Database (CSD).",
  evaluation: "Bids will be evaluated on the 80/20 preference point system.",
  pricing: "Bidders must quote a price per learner per school day, inclusive of VAT, ingredients, cooking fuel and delivery.",
  payment: "Valid invoices will be paid within 30 days of receipt.",
};

export const schoolNutritionCatering: EvalFixture = {
  id: "school-nutrition-catering",
  title: "School nutrition programme catering",
  description: "Education department catering tender with food-safety documents, a local-employment condition and a per-learner price.",
  tags: ["sector:education", "sector:cleaning"],
  tender: {
    reference_number: "ECDOE/NSNP/2026/05",
    title: "Provision of cooked meals to learners, Mbizana circuit",
    issuing_organisation: "Eastern Cape Department of Education",
    province: "EASTERN_CAPE",
    sector: "Catering",
    estimated_value_zar: 21_000_000,
    closing_at: "2026-10-29T09:00:00.000Z",
    briefing_at: "2026-10-13T08:00:00.000Z",
    briefing_compulsory: true,
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Bid document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.closing, L.briefing) },
        { page: 2, text: page(L.coa, L.medical, L.menu, L.local, L.csd) },
        { page: 3, text: page(L.evaluation, L.pricing, L.payment) },
      ],
    },
  ],
  company: "facilities",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["29 October 2026", "closing"], { date: { kind: "CLOSING", iso: "2026-10-29T11:00:00+02:00" } }),
      expectReq(D, "briefing", "BRIEFING", true, L.briefing, 1, ["compulsory briefing"], { date: { kind: "BRIEFING", iso: "2026-10-13T10:00:00+02:00" } }),
      expectReq(D, "coa", "DOCUMENT", true, L.coa, 2, ["Certificate of Acceptability"]),
      expectReq(D, "medical", "DOCUMENT", true, L.medical, 2, ["medical certificates", "food handler"]),
      expectReq(D, "menu", "DOCUMENT", true, L.menu, 2, ["menu"]),
      expectReq(D, "local", "MANDATORY_CONDITION", true, L.local, 2, ["30%", "local community"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["80/20"]),
      expectReq(D, "pricing", "PRICING", true, L.pricing, 3, ["per learner per school day"]),
      expectReq(D, "payment", "PRICING", false, L.payment, 3, ["30 days"]),
    ],
    forbidden: [],
    gaps: [],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
