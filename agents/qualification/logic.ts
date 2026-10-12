import type { CompanyProfile, TenderSnapshot } from "@/agents/runtime/types";
import { hoursUntil } from "@/lib/domain/time";
import type { AiFitModel, QualificationFactor, QualificationOutput } from "./schema";
import { formatSast } from "@/lib/format";

/** Minimum hours before closing needed to prepare a compliant bid. */
export const MIN_PREPARATION_HOURS = 48;

/** Company capability inputs. Null until the company profile exists (Phase 5). */
export interface CompanyFitInputs {
  provinces: string[];
  sectors: string[];
  maxContractValueZar: number | null;
}

/** The profile facts the rule gates compare with. Null until the organisation has recorded something to compare. */
export function companyFitInputs(p: CompanyProfile | null): CompanyFitInputs | null {
  return p && (p.provinces.length || p.sectors.length || p.max_contract_value_zar != null)
    ? { provinces: p.provinces, sectors: p.sectors, maxContractValueZar: p.max_contract_value_zar }
    : null;
}

/** Problems that make a drafted fit assessment unusable. They are sent back to the model once for repair. */
export function validateFit(fit: AiFitModel, factIds: ReadonlySet<string>, requirementIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  fit.reasons.forEach((r, i) => {
    for (const id of r.fact_ids) if (!factIds.has(id)) issues.push(`reasons[${i}] cites fact id "${id}", which is not one of the supplied company facts`);
    for (const id of r.requirement_ids) if (!requirementIds.has(id)) issues.push(`reasons[${i}] cites requirement id "${id}", which is not one of the supplied requirements`);
    if (r.assessment === "SUPPORTS" && r.fact_ids.length === 0) issues.push(`reasons[${i}] says SUPPORTS but cites no company fact; use UNKNOWN when no fact backs it`);
  });
  fit.risks.forEach((r, i) => {
    for (const id of r.requirement_ids) if (!requirementIds.has(id)) issues.push(`risks[${i}] cites requirement id "${id}", which is not one of the supplied requirements`);
  });
  return issues;
}

/** The AI assessment as one display factor. It is never a hard disqualifier, and low confidence asks for confirmation instead of a verdict. */
export function fitFactor(fit: Pick<AiFitModel, "score" | "confidence" | "reasons" | "risks">): QualificationFactor {
  const result = fit.confidence === "LOW" ? "REQUIRES_CONFIRMATION" : fit.score >= 70 ? "PASS" : fit.score >= 40 ? "WARN" : "FAIL";
  return {
    key: "ai_fit",
    label: "AI fit assessment (draft)",
    result,
    hard_disqualifier: false,
    evidence: `Drafted by AI from the recorded company facts: ${fit.score}/100, ${fit.confidence.toLowerCase()} confidence, ${fit.reasons.length} reasons, ${fit.risks.length} risks. A person must review it`,
  };
}

/**
 * Explainable qualification. Each factor carries evidence; any hard
 * disqualifier rejects the tender regardless of the fit score. Facts the
 * system does not have are REQUIRES_CONFIRMATION, never assumed.
 */
export function assessQualification(t: TenderSnapshot, now: Date, company: CompanyFitInputs | null): Omit<QualificationOutput, "simulated"> {
  const f: QualificationFactor[] = [];
  const hours = hoursUntil(t.closing_at, now)!;

  if (hours <= 0) {
    f.push({ key: "deadline", label: "Closing date", result: "FAIL", hard_disqualifier: true, evidence: `Closed at ${formatSast(t.closing_at)}` });
  } else if (hours < MIN_PREPARATION_HOURS) {
    f.push({
      key: "deadline",
      label: "Closing date",
      result: "FAIL",
      hard_disqualifier: true,
      evidence: `Only ${Math.floor(hours)}h left; at least ${MIN_PREPARATION_HOURS}h are needed to prepare a compliant bid`,
    });
  } else {
    f.push({ key: "deadline", label: "Closing date", result: "PASS", hard_disqualifier: false, evidence: `${Math.floor(hours / 24)} days until closing` });
  }

  if (t.briefing_compulsory) {
    const bh = hoursUntil(t.briefing_at, now);
    if (bh === null) {
      f.push({
        key: "briefing",
        label: "Compulsory briefing",
        result: "REQUIRES_CONFIRMATION",
        hard_disqualifier: false,
        evidence: "Briefing is compulsory but its date is not recorded",
      });
    } else if (bh <= 0) {
      f.push({
        key: "briefing",
        label: "Compulsory briefing",
        result: "FAIL",
        hard_disqualifier: true,
        evidence: `Compulsory briefing was held at ${formatSast(t.briefing_at)}; attendance cannot be confirmed`,
      });
    } else {
      f.push({
        key: "briefing",
        label: "Compulsory briefing",
        result: "WARN",
        hard_disqualifier: false,
        evidence: `Attendance required at ${formatSast(t.briefing_at)}`,
      });
    }
  }

  if (t.submission_method === "UNKNOWN") {
    f.push({
      key: "submission",
      label: "Submission method",
      result: "REQUIRES_CONFIRMATION",
      hard_disqualifier: false,
      evidence: "Submission method not recorded",
    });
  } else if (t.submission_method === "PHYSICAL") {
    f.push({
      key: "submission",
      label: "Submission method",
      result: "WARN",
      hard_disqualifier: false,
      evidence: "Physical delivery required; a person must deliver the bid",
    });
  } else {
    f.push({ key: "submission", label: "Submission method", result: "PASS", hard_disqualifier: false, evidence: t.submission_method });
  }

  if (!company) {
    for (const [key, label] of [
      ["capability", "Business capability"],
      ["geography", "Geographic feasibility"],
      ["financial", "Financial capacity"],
      ["experience", "Past experience"],
    ] as const) {
      f.push({ key, label, result: "REQUIRES_CONFIRMATION", hard_disqualifier: false, evidence: "Company profile not configured; cannot assess" });
    }
  } else {
    const inProvince = t.province === "NATIONAL" || t.province === "UNKNOWN" || company.provinces.includes(t.province);
    f.push({
      key: "geography",
      label: "Geographic feasibility",
      result: t.province === "UNKNOWN" ? "REQUIRES_CONFIRMATION" : inProvince ? "PASS" : "WARN",
      hard_disqualifier: false,
      evidence: `Tender province ${t.province}; company covers ${company.provinces.join(", ") || "no provinces recorded"}`,
    });
    const sectorMatch = t.sector ? company.sectors.some((s) => s.toLowerCase() === t.sector!.toLowerCase()) : null;
    f.push({
      key: "capability",
      label: "Business capability",
      result: sectorMatch === null ? "REQUIRES_CONFIRMATION" : sectorMatch ? "PASS" : "WARN",
      hard_disqualifier: false,
      evidence: t.sector ? `Sector "${t.sector}" ${sectorMatch ? "matches" : "does not match"} company sectors` : "Tender sector not recorded",
    });
    if (company.maxContractValueZar != null && t.estimated_value_zar != null) {
      const over = Number(t.estimated_value_zar) > company.maxContractValueZar;
      f.push({
        key: "financial",
        label: "Contract size vs exposure limit",
        result: over ? "FAIL" : "PASS",
        hard_disqualifier: over,
        evidence: `Estimated R${Number(t.estimated_value_zar).toLocaleString("en-ZA")} vs limit R${company.maxContractValueZar.toLocaleString("en-ZA")}`,
      });
    } else {
      f.push({
        key: "financial",
        label: "Contract size vs exposure limit",
        result: "REQUIRES_CONFIRMATION",
        hard_disqualifier: false,
        evidence: "Contract value or exposure limit unknown",
      });
    }
  }

  const hard = f.filter((x) => x.hard_disqualifier && x.result === "FAIL");
  const assessable = f.filter((x) => x.result !== "REQUIRES_CONFIRMATION");
  const score = assessable.length ? Math.round((assessable.filter((x) => x.result === "PASS").length / assessable.length) * 100) : null;

  return {
    decision: hard.length ? "REJECTED" : "QUALIFIED",
    confirmation_required: f.some((x) => x.result === "REQUIRES_CONFIRMATION"),
    fit_score: score,
    factors: f,
    hard_disqualifiers: hard.map((x) => `${x.label}: ${x.evidence}`),
  };
}
