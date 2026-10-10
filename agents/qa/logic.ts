import type { TenderSnapshot } from "@/agents/runtime/types";
import { hoursUntil } from "@/lib/domain/time";
import type { QaCheck, QaOutput } from "./schema";

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

  const fails = checks.filter((c) => c.result === "FAIL");
  const issues = checks.filter((c) => c.result === "OPEN_ISSUE");
  return {
    verdict: fails.length ? "FAIL" : issues.length ? "CONDITIONAL" : "PASS",
    checks,
    open_issues: [...fails, ...issues].map((c) => `${c.label}: ${c.detail}`),
  };
}
