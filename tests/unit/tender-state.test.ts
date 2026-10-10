import { describe, expect, it } from "vitest";
import { ALL_TENDER_STATUSES, assertTransition, canTransition, InvalidTransitionError, pipelineStage, TENDER_TRANSITIONS } from "@/lib/domain/tender-state";

describe("tender state machine", () => {
  it("follows the happy path from discovery to submission", () => {
    const path = [
      "DISCOVERED",
      "INGESTING",
      "ANALYSING",
      "QUALIFYING",
      "QUALIFIED",
      "COMPLIANCE_REVIEW",
      "PREPARING_BID",
      "PRICING",
      "QUALITY_ASSURANCE",
      "READY_FOR_APPROVAL",
      "APPROVED",
      "SUBMITTING",
      "SUBMITTED",
      "AWARDED",
      "ARCHIVED",
    ] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i]), `${path[i - 1]}->${path[i]}`).toBe(true);
  });

  it("cannot skip approval", () => {
    expect(canTransition("QUALITY_ASSURANCE", "SUBMITTING")).toBe(false);
    expect(canTransition("READY_FOR_APPROVAL", "SUBMITTING")).toBe(false);
    expect(canTransition("PRICING", "SUBMITTED")).toBe(false);
  });

  it("throws a typed error on invalid transitions", () => {
    expect(() => assertTransition("DISCOVERED", "SUBMITTED")).toThrow(InvalidTransitionError);
  });

  it("archived is terminal and nothing transitions to itself", () => {
    expect(TENDER_TRANSITIONS.ARCHIVED).toEqual([]);
    for (const s of ALL_TENDER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("every status maps to a pipeline stage", () => {
    for (const s of ALL_TENDER_STATUSES) expect(pipelineStage(s)).toBeTruthy();
  });
});
