import { formatSast, formatZar } from "@/lib/format";
import type { TenderSnapshot } from "../types";

/** The public tender record as text for a prompt. Only PUBLIC_TENDER_DATA fields. */
export function renderTenderRecord(t: TenderSnapshot): string {
  const lines: Array<[string, string | null]> = [
    ["Reference", t.reference_number],
    ["Title", t.title],
    ["Issuing organisation", t.issuing_organisation],
    ["Description", t.description],
    ["Province", t.province],
    ["Sector", t.sector],
    ["Estimated value", t.estimated_value_zar != null ? formatZar(Number(t.estimated_value_zar)) : null],
    ["Published", t.published_at ? formatSast(t.published_at) : null],
    ["Closing", formatSast(t.closing_at)],
    ["Briefing", t.briefing_at ? `${formatSast(t.briefing_at)}${t.briefing_compulsory ? " (compulsory)" : ""}` : t.briefing_compulsory ? "compulsory, date not recorded" : null],
    ["Questions deadline", t.questions_deadline_at ? formatSast(t.questions_deadline_at) : null],
    ["Submission method", t.submission_method],
  ];
  return lines
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** Requirements from the analysis step, one citable line each. */
export function renderRequirements(
  reqs: Array<{ id: string; category: string; text: string; mandatory: boolean; status: string }>,
  limit = 80,
): string {
  return reqs
    .slice(0, limit)
    .map((r) => `[${r.id}] (${r.category}${r.mandatory ? ", mandatory" : ""}${r.status === "EXTRACTED" ? "" : ", unconfirmed"}) ${r.text}`)
    .join("\n");
}
