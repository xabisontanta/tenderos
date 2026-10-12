import type { EvalFixture } from "../types";
import { expectReq, page } from "./helpers";

const D = "doc-bridge";
const L = {
  title: "TENDER NCDRT/INF/2026/12: REPAIR OF THE KURUMAN RIVER PEDESTRIAN BRIDGE",
  intro: "The Northern Cape Department of Roads and Public Works invites tenders for the repair of the Kuruman River pedestrian bridge.",
  coverClosing: "Closing date: 14 October 2026 at 11:00.",
  cidb: "Tenderers must hold a valid CIDB grading of 5CE or higher.",
  csd: "Tenderers must be registered on the Central Supplier Database (CSD).",
  evaluation: "Tenders will be evaluated on the 80/20 preference point system.",
  forms: "Tenderers must submit completed SBD 1, SBD 4 and SBD 6.1 forms.",
  conditionsClosing: "Closing date: 21 October 2026 at 11:00.",
  placement: "Tenders must be placed in the tender box at the departmental head office in Kimberley.",
};

export const adversarialConflictingDates: EvalFixture = {
  id: "adversarial-conflicting-dates",
  title: "Bridge repair tender with two different closing dates",
  description:
    "The cover page and the conditions of tender give different closing dates, and the portal record agrees with only one. The analyst must report the conflict and not choose a date.",
  tags: ["adversarial:conflicting-dates", "sector:construction"],
  tender: {
    reference_number: "NCDRT/INF/2026/12",
    title: "Repair of the Kuruman River pedestrian bridge",
    issuing_organisation: "Northern Cape Department of Roads and Public Works",
    province: "NORTHERN_CAPE",
    sector: "Construction",
    estimated_value_zar: 4_800_000,
    closing_at: "2026-10-21T09:00:00.000Z",
    submission_method: "PHYSICAL",
  },
  documents: [
    {
      id: D,
      title: "Tender document",
      pages: [
        { page: 1, text: page(L.title, L.intro, L.coverClosing) },
        { page: 2, text: page(L.cidb, L.csd, L.forms) },
        { page: 3, text: page(L.evaluation, L.conditionsClosing, L.placement) },
      ],
    },
  ],
  company: "civils",
  expected: {
    requirements: [
      expectReq(D, "closing-cover", "DEADLINE", true, L.coverClosing, 1, ["14 October 2026", "closing"], {
        status: "REQUIRES_CONFIRMATION",
        date: { kind: "CLOSING", iso: "2026-10-14T11:00:00+02:00" },
      }),
      expectReq(D, "closing-conditions", "DEADLINE", true, L.conditionsClosing, 3, ["21 October 2026", "closing"], {
        status: "REQUIRES_CONFIRMATION",
        date: { kind: "CLOSING", iso: "2026-10-21T11:00:00+02:00" },
      }),
      expectReq(D, "cidb", "MANDATORY_CONDITION", true, L.cidb, 2, ["CIDB", "5CE"]),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 2, ["CSD", "Central Supplier Database"]),
      expectReq(D, "forms", "DOCUMENT", true, L.forms, 2, ["SBD"]),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 3, ["80/20"]),
      expectReq(D, "placement", "SUBMISSION", true, L.placement, 3, ["tender box", "Kimberley"]),
    ],
    forbidden: [],
    gaps: ["different closing dates", "differs from the tender record"],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
