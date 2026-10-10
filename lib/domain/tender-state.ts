import type { Database } from "@/types/database";

export type TenderStatus = Database["public"]["Enums"]["tender_status"];

/**
 * Allowed tender transitions. Mirrors private.tender_transition_allowed() in
 * supabase/migrations/*_tenders.sql; tests/integration/state-machine.test.ts
 * asserts the two agree.
 */
export const TENDER_TRANSITIONS: Record<TenderStatus, readonly TenderStatus[]> = {
  DISCOVERED: ["INGESTING", "QUALIFYING", "REJECTED", "CANCELLED", "ARCHIVED"],
  INGESTING: ["ANALYSING", "CANCELLED"],
  ANALYSING: ["QUALIFYING", "CANCELLED"],
  QUALIFYING: ["QUALIFIED", "REJECTED", "CANCELLED"],
  REJECTED: ["QUALIFYING", "ARCHIVED"],
  QUALIFIED: ["COMPLIANCE_REVIEW", "CANCELLED"],
  COMPLIANCE_REVIEW: ["PREPARING_BID", "MISSING_INFORMATION", "CANCELLED"],
  MISSING_INFORMATION: ["COMPLIANCE_REVIEW", "CANCELLED"],
  PREPARING_BID: ["PRICING", "QUALITY_ASSURANCE", "CLARIFICATION", "CANCELLED"],
  PRICING: ["QUALITY_ASSURANCE", "PREPARING_BID", "CANCELLED"],
  QUALITY_ASSURANCE: ["READY_FOR_APPROVAL", "QA_FAILED", "CANCELLED"],
  QA_FAILED: ["PREPARING_BID", "PRICING", "CANCELLED"],
  READY_FOR_APPROVAL: ["APPROVED", "PREPARING_BID", "CANCELLED"],
  APPROVED: ["SUBMITTING", "CANCELLED"],
  SUBMITTING: ["SUBMITTED", "SUBMISSION_FAILED"],
  SUBMISSION_FAILED: ["SUBMITTING", "READY_FOR_APPROVAL", "CANCELLED"],
  SUBMITTED: ["UNDER_EVALUATION", "CLARIFICATION", "AWARDED", "UNSUCCESSFUL"],
  UNDER_EVALUATION: ["CLARIFICATION", "AWARDED", "UNSUCCESSFUL", "CANCELLED"],
  CLARIFICATION: ["UNDER_EVALUATION", "PREPARING_BID", "CANCELLED"],
  AWARDED: ["ARCHIVED"],
  UNSUCCESSFUL: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

export const ALL_TENDER_STATUSES = Object.keys(TENDER_TRANSITIONS) as TenderStatus[];

export function canTransition(from: TenderStatus, to: TenderStatus): boolean {
  return TENDER_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TenderStatus,
    readonly to: TenderStatus,
  ) {
    super(`Invalid tender transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TenderStatus, to: TenderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const TERMINAL_TENDER_STATUSES: readonly TenderStatus[] = ["AWARDED", "UNSUCCESSFUL", "CANCELLED", "ARCHIVED"];

/** Statuses a user may set by hand; everything else belongs to the workflow engine. */
export const USER_SETTABLE_STATUSES: readonly TenderStatus[] = [
  "CANCELLED",
  "ARCHIVED",
  "UNDER_EVALUATION",
  "AWARDED",
  "UNSUCCESSFUL",
];

/** Coarse pipeline stage used for dashboard grouping. */
export type PipelineStage = "new" | "qualifying" | "preparing" | "approval" | "submitted" | "won" | "lost" | "closed";

export function pipelineStage(status: TenderStatus): PipelineStage {
  switch (status) {
    case "DISCOVERED":
      return "new";
    case "INGESTING":
    case "ANALYSING":
    case "QUALIFYING":
      return "qualifying";
    case "QUALIFIED":
    case "COMPLIANCE_REVIEW":
    case "MISSING_INFORMATION":
    case "PREPARING_BID":
    case "PRICING":
    case "QUALITY_ASSURANCE":
    case "QA_FAILED":
      return "preparing";
    case "READY_FOR_APPROVAL":
    case "APPROVED":
    case "SUBMITTING":
    case "SUBMISSION_FAILED":
      return "approval";
    case "SUBMITTED":
    case "UNDER_EVALUATION":
    case "CLARIFICATION":
      return "submitted";
    case "AWARDED":
      return "won";
    case "UNSUCCESSFUL":
      return "lost";
    case "REJECTED":
    case "CANCELLED":
    case "ARCHIVED":
      return "closed";
  }
}
