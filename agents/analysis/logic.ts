import type { TenderSnapshot } from "@/agents/runtime/types";
import type { AnalysisOutput, Requirement } from "./schema";

/**
 * Extracts requirements from the structured tender record only. Every
 * requirement cites the record field it came from. Document analysis needs
 * ingested tender documents (Phase 4), so it is reported as a gap rather than
 * guessed.
 */
export function extractRecordRequirements(t: TenderSnapshot): Pick<AnalysisOutput, "requirements" | "gaps"> {
  const reqs: Requirement[] = [];
  const gaps: string[] = [];
  const rec = (field: string) => ({ kind: "TENDER_RECORD" as const, field });

  reqs.push({
    id: "closing",
    category: "DEADLINE",
    text: `Submission closes ${t.closing_at}`,
    mandatory: true,
    status: "EXTRACTED",
    source: rec("closing_at"),
  });

  if (t.briefing_compulsory) {
    reqs.push({
      id: "briefing",
      category: "BRIEFING",
      text: t.briefing_at
        ? `Compulsory briefing at ${t.briefing_at}${t.briefing_location ? `, ${t.briefing_location}` : ""}`
        : "Compulsory briefing: date not recorded",
      mandatory: true,
      status: t.briefing_at ? "EXTRACTED" : "MISSING_INFORMATION",
      source: rec("briefing_at"),
    });
  }

  if (t.questions_deadline_at) {
    reqs.push({
      id: "questions",
      category: "DEADLINE",
      text: `Questions close ${t.questions_deadline_at}`,
      mandatory: false,
      status: "EXTRACTED",
      source: rec("questions_deadline_at"),
    });
  }

  reqs.push({
    id: "submission_method",
    category: "SUBMISSION",
    text:
      t.submission_method === "UNKNOWN"
        ? "Submission method not recorded"
        : `Submit via ${t.submission_method.replaceAll("_", " ").toLowerCase()}${t.submission_destination ? ` to ${t.submission_destination}` : ""}`,
    mandatory: true,
    status: t.submission_method === "UNKNOWN" ? "MISSING_INFORMATION" : "EXTRACTED",
    source: rec("submission_method"),
  });

  if (!t.description) gaps.push("No scope description on the tender record");
  gaps.push("No tender documents ingested; forms, evaluation criteria and mandatory conditions cannot be extracted yet");
  return { requirements: reqs, gaps };
}
