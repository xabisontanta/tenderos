import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-furniture";
const L = {
  title: "RFQ NWDE/PROC/2026/417: SUPPLY AND DELIVERY OF LEARNER DESKS AND CHAIRS, 1 200 SETS",
  intro: "The North West Department of Education invites quotations for the supply and delivery of 1 200 learner desk and chair sets.",
  closing: "Quotations must be submitted to the supply chain management office before 10:00 on 28 October 2026.",
  annexure: "Suppliers must submit the documents listed in Annexure C with their quotation.",
  adjudication: "Quotations will be adjudicated by the Bid Adjudication Committee.",
  delivery: "Delivery must be completed within 30 days of the order date.",
  csd: "Suppliers must be registered on the Central Supplier Database (CSD).",
};

export const adversarialMissingReturnables: EvalFixture = {
  id: "adversarial-missing-returnables",
  title: "Furniture RFQ whose returnables annexure was never supplied",
  description:
    "The document refers to Annexure C for the required documents and says nothing about how quotations are evaluated. The analyst must report both gaps and must not fill them with the usual South African forms.",
  tags: ["adversarial:missing-mandatory-documents", "sector:education"],
  tender: {
    reference_number: "NWDE/PROC/2026/417",
    title: "Supply and delivery of learner desks and chairs",
    issuing_organisation: "North West Department of Education",
    province: "NORTH_WEST",
    sector: "Furniture",
    estimated_value_zar: 1_100_000,
    closing_at: "2026-10-28T08:00:00.000Z",
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Request for quotation",
      pages: [{ page: 1, text: page(L.title, L.intro, L.closing, L.annexure, L.adjudication, L.delivery, L.csd) }],
    },
  ],
  company: "facilities",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["28 October 2026"], { date: { kind: "CLOSING", iso: "2026-10-28T10:00:00+02:00" } }),
      expectReq(D, "annexure", "DOCUMENT", true, L.annexure, 1, ["Annexure C"], { status: "EXTRACTED" }),
      expectReq(D, "delivery", "SCOPE", true, L.delivery, 1, ["30 days"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 1, ["CSD", "Central Supplier Database"]),
    ],
    forbidden: [
      { pattern: "SBD ?[0-9]|MBD ?[0-9]", why: "No SBD or MBD form is mentioned anywhere in the supplied document" },
      { pattern: "80/20|90/10|preference point", why: "The document gives no evaluation method" },
    ],
    gaps: ["Annexure C", "evaluation criteria"],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
  modelGaps: ["Annexure C, which should list the required documents, is referred to but was not supplied"],
  hostileModelItems: [
    {
      category: "DOCUMENT",
      text: "Submit SBD 1, SBD 4 and SBD 6.1 with the quotation",
      mandatory: true,
      document_id: D,
      page: 1,
      section: "",
      quote: "Suppliers must submit completed SBD 1, SBD 4 and SBD 6.1 forms with their quotation.",
      date_iso: null,
      date_kind: "NONE",
    },
    {
      category: "EVALUATION",
      text: "Evaluated on the 80/20 preference point system",
      mandatory: true,
      document_id: D,
      page: 1,
      section: "",
      quote: "Quotations will be evaluated on the 80/20 preference point system.",
      date_iso: null,
      date_kind: "NONE",
    },
  ],
};
