import { complianceOutputSchema } from "@/agents/compliance/schema";
import { pricingOutputSchema } from "@/agents/pricing/schema";
import { proposalOutputSchema } from "@/agents/proposal/schema";
import type { TenderSnapshot } from "@/agents/runtime/types";
import { hoursUntil } from "@/lib/domain/time";
import type { QaCheck, QaModel, QaOutput } from "./schema";

export const REQUIRED_STEPS = ["intake", "analysis", "qualification", "compliance", "proposal", "pricing"] as const;

interface PriorOutputs {
  compliance?: { missing?: string[] };
  proposal?: { open_items?: number };
  pricing?: { status?: string };
  qualification?: { decision?: string };
}

/**
 * Independent bid review. Hard failures (deadline passed, missing step, not
 * qualified) fail QA. Open issues make the verdict CONDITIONAL so a human
 * sees them before approving.
 */
export function reviewBid(t: Pick<TenderSnapshot, "closing_at">, prior: Record<string, unknown>, now: Date): Omit<QaOutput, "simulated"> {
  const p = prior as PriorOutputs;
  const checks: QaCheck[] = [];

  const hours = hoursUntil(t.closing_at, now)!;
  checks.push(
    hours > 0
      ? { key: "deadline", label: "Deadline", result: "PASS", detail: `${Math.floor(hours)}h before closing` }
      : { key: "deadline", label: "Deadline", result: "FAIL", detail: "Closing date has passed" },
  );

  const missingSteps = REQUIRED_STEPS.filter((s) => !(s in prior));
  checks.push(
    missingSteps.length
      ? { key: "steps", label: "Workflow completeness", result: "FAIL", detail: `Missing: ${missingSteps.join(", ")}` }
      : { key: "steps", label: "Workflow completeness", result: "PASS", detail: "All preparation steps completed" },
  );

  checks.push(
    p.qualification?.decision === "QUALIFIED"
      ? { key: "eligibility", label: "Eligibility", result: "PASS", detail: "Qualified" }
      : { key: "eligibility", label: "Eligibility", result: "FAIL", detail: "Tender not qualified" },
  );

  const missingDocs = p.compliance?.missing ?? [];
  checks.push(
    missingDocs.length
      ? { key: "documents", label: "Mandatory documents", result: "OPEN_ISSUE", detail: `${missingDocs.length} missing: ${missingDocs.join(", ")}` }
      : { key: "documents", label: "Mandatory documents", result: "PASS", detail: "All present" },
  );

  const openSections = p.proposal?.open_items ?? 0;
  checks.push(
    openSections
      ? { key: "technical", label: "Technical response", result: "OPEN_ISSUE", detail: `${openSections} sections need information` }
      : { key: "technical", label: "Technical response", result: "PASS", detail: "Complete" },
  );

  checks.push(
    p.pricing?.status === "READY_FOR_APPROVAL"
      ? { key: "pricing", label: "Pricing completeness", result: "PASS", detail: "Priced" }
      : { key: "pricing", label: "Pricing completeness", result: "OPEN_ISSUE", detail: "Pricing has unconfirmed figures" },
  );

  return { checks, ...verdictOf(checks) };
}

// ---------------------------------------------------------------------------
// AI-assisted coverage review
// ---------------------------------------------------------------------------

/** A requirement from the analysis step, as far as the review needs it. */
export interface ReviewedRequirement {
  id: string;
  category: string;
  text: string;
  mandatory: boolean;
  status: string;
  source: { kind: string; quote?: string };
}

/** One piece of bid content the model may cite, and whether it is finished. */
export interface Evidence {
  complete: boolean;
  /** Plain words for a check's detail, such as "MISSING_INFORMATION". */
  state: string;
}

/** How many requirements one review covers. Mandatory ones come first. */
export const MAX_REVIEWED_REQUIREMENTS = 60;

/** The requirements the model reviews: those read from tender documents, mandatory first. */
export function reviewSet(reqs: ReviewedRequirement[]): { reviewed: ReviewedRequirement[]; skipped: number } {
  const fromDocs = reqs.filter((r) => r.source.kind === "TENDER_DOCUMENT");
  const ordered = [...fromDocs.filter((r) => r.mandatory), ...fromDocs.filter((r) => !r.mandatory)];
  return { reviewed: ordered.slice(0, MAX_REVIEWED_REQUIREMENTS), skipped: Math.max(0, ordered.length - MAX_REVIEWED_REQUIREMENTS) };
}

/**
 * Bid content the model may cite, keyed by the ids shown to it. Content is
 * complete only when the step that produced it says so: a drafted section, a
 * valid compliance item, or a priced schedule. Anything else is evidence of
 * an open issue, not of a pass.
 */
export function buildEvidence(prior: Record<string, unknown>): Map<string, Evidence> {
  const evidence = new Map<string, Evidence>();
  const proposal = proposalOutputSchema.safeParse(prior.proposal);
  if (proposal.success) for (const s of proposal.data.sections) evidence.set(`section:${s.key}`, { complete: s.status === "DRAFTED", state: s.status });
  const compliance = complianceOutputSchema.safeParse(prior.compliance);
  if (compliance.success) {
    for (const i of compliance.data.items) evidence.set(`compliance:${i.key}`, { complete: i.status === "VALID" || i.status === "EXPIRING_SOON", state: i.status });
  }
  const pricing = pricingOutputSchema.safeParse(prior.pricing);
  if (pricing.success) {
    for (const l of pricing.data.lines) {
      if (l.requirement_id) evidence.set(`pricing:${l.requirement_id}`, { complete: pricing.data.status === "READY_FOR_APPROVAL", state: pricing.data.status });
    }
  }
  return evidence;
}

const short = (s: string, n: number) => s.trim().replace(/\s+/g, " ").slice(0, n);

/**
 * Turns the model's coverage findings into checks. Only a requirement that is
 * itself confirmed, that the model says is ADDRESSED, and whose cited
 * evidence exists and is complete, passes. Everything else, including a
 * requirement the model never mentioned, is an open issue. The model cannot
 * produce a FAIL.
 */
export function coverageChecks(reviewed: ReviewedRequirement[], model: QaModel, evidence: ReadonlyMap<string, Evidence>): QaCheck[] {
  return reviewed.map((r): QaCheck => {
    const key = `req:${r.id}`;
    const label = `Requirement ${r.id}: ${short(r.text, 80)}`;
    const found = model.coverage.find((c) => c.requirement_id === r.id);
    const open = (detail: string, refs?: string[]): QaCheck => ({ key, label, result: "OPEN_ISSUE", detail, ...(refs?.length ? { evidence_refs: refs } : {}) });

    if (r.status !== "EXTRACTED") return open(`The requirement itself is unconfirmed; confirm it before relying on this check${found ? ` (${short(found.detail, 160)})` : ""}`);
    if (!found) return open("Could not be determined: the review did not cover this requirement");
    const refs = found.evidence_refs;
    if (found.result === "PARTIALLY_ADDRESSED") return open(`Partly addressed: ${short(found.detail, 200)}`, refs.filter((x) => evidence.has(x)));
    if (found.result === "NOT_ADDRESSED") return open(`Not addressed: ${short(found.detail, 200)}`);
    if (found.result === "CANNOT_DETERMINE") return open(`Could not be determined: ${short(found.detail, 200)}`);

    const unknown = refs.filter((x) => !evidence.has(x));
    if (refs.length === 0) return open("Claimed as addressed but no evidence was cited");
    if (unknown.length) return open(`Claimed as addressed but cites content that does not exist (${unknown.join(", ")})`);
    const incomplete = refs.filter((x) => !evidence.get(x)!.complete);
    if (incomplete.length === refs.length) {
      return open(`The cited content is not complete yet (${incomplete.map((x) => `${x} is ${evidence.get(x)!.state}`).join("; ")})`, refs);
    }
    return { key, label, result: "PASS", detail: short(found.detail, 200), evidence_refs: refs };
  });
}

/** The model's other findings as open issues. References that do not exist are dropped, the finding is kept. */
export function findingChecks(model: QaModel, validRefs: ReadonlySet<string>): QaCheck[] {
  const consistency = model.inconsistencies.slice(0, 10).map((f, i): QaCheck => {
    const refs = f.refs.filter((x) => validRefs.has(x));
    return { key: `consistency:${i + 1}`, label: "Consistency", result: "OPEN_ISSUE", detail: short(f.detail, 300), ...(refs.length ? { evidence_refs: refs } : {}) };
  });
  const other = model.other_issues
    .map((t) => short(t, 300))
    .filter(Boolean)
    .slice(0, 5)
    .map((detail, i): QaCheck => ({ key: `other:${i + 1}`, label: "Other finding", result: "OPEN_ISSUE", detail }));
  return [...consistency, ...other];
}

/** One verdict over every check: any FAIL fails, any open issue is conditional, otherwise pass. */
export function verdictOf(checks: QaCheck[]): Pick<QaOutput, "verdict" | "open_issues"> {
  const fails = checks.filter((c) => c.result === "FAIL");
  const issues = checks.filter((c) => c.result === "OPEN_ISSUE");
  return { verdict: fails.length ? "FAIL" : issues.length ? "CONDITIONAL" : "PASS", open_issues: [...fails, ...issues].map((c) => `${c.label}: ${c.detail}`) };
}
