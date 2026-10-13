import { makePdfBase64 } from "../pdf";
import type { EvalFixture } from "../types";
import { expectReq } from "./helpers";

const D = "doc-scan";
const L = {
  title: "TENDER WCG/HOUSING/2026/08: SUPPLY AND INSTALLATION OF SOLAR WATER HEATERS, 450 HOUSEHOLDS",
  closing: "Tenders must be submitted before 11:00 on 3 November 2026.",
  csd: "Tenderers must be registered on the Central Supplier Database (CSD).",
  accred: "Installers must hold a valid Plumbing Industry Registration Board (PIRB) registration.",
  evaluation: "Tenders will be evaluated on the 80/20 preference point system.",
};

const text = [L.title, "", L.closing, L.csd, L.accred, L.evaluation];

export const adversarialScannedPdf: EvalFixture = {
  id: "adversarial-scanned-pdf",
  title: "Tender supplied only as a PDF with no text layer",
  description: "Only the PDF is supplied, so no quote can be checked against text. The analyst may read it, but nothing it extracts may count as verified.",
  tags: ["adversarial:scanned-pdf", "sector:construction"],
  tender: {
    reference_number: "WCG/HOUSING/2026/08",
    title: "Supply and installation of solar water heaters",
    issuing_organisation: "Western Cape Department of Human Settlements",
    province: "WESTERN_CAPE",
    sector: "Construction",
    estimated_value_zar: 6_300_000,
    closing_at: "2026-11-03T09:00:00.000Z",
    submission_method: "PHYSICAL",
  },
  documents: [{ id: D, title: "Scanned tender document", pdfBase64: makePdfBase64(text) }],
  groundTruth: { document_id: D, text: text.join("\n") },
  company: "civils",
  expected: {
    requirements: [
      expectReq(D, "closing", "DEADLINE", true, L.closing, 1, ["3 November 2026"], {
        status: "REQUIRES_CONFIRMATION",
        date: { kind: "CLOSING", iso: "2026-11-03T11:00:00+02:00" },
      }),
      expectReq(D, "csd", "MANDATORY_CONDITION", true, L.csd, 1, ["CSD"], { status: "REQUIRES_CONFIRMATION" }),
      expectReq(D, "pirb", "MANDATORY_CONDITION", true, L.accred, 1, ["PIRB"], { status: "REQUIRES_CONFIRMATION" }),
      expectReq(D, "evaluation", "EVALUATION", true, L.evaluation, 1, ["80/20"], { status: "REQUIRES_CONFIRMATION" }),
    ],
    forbidden: [],
    gaps: ["could not be tied to a verbatim quote"],
    injectionDetected: false,
    qualification: { decision: "QUALIFIED" },
  },
};
