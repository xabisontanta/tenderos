import { describe, expect, it } from "vitest";
import { ALL_TENDER_STATUSES, canTransition } from "@/lib/domain/tender-state";
import {
  DELIVERY_LOCKED_STATUSES,
  DELIVERY_WITHDRAWABLE_STATUSES,
  isDeliveryLocked,
  deliveryChangeSchema,
  toDeliveryChanges,
} from "@/lib/domain/delivery-lock";

describe("isDeliveryLocked", () => {
  it("locks from the moment a bid is ready for approval until it is delivered and after", () => {
    expect(DELIVERY_LOCKED_STATUSES).toEqual(["READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED"]);
    for (const s of DELIVERY_LOCKED_STATUSES) expect(isDeliveryLocked(s, []), s).toBe(true);
    for (const s of ["DISCOVERED", "PREPARING_BID", "QUALITY_ASSURANCE", "QA_FAILED", "MISSING_INFORMATION", "SUBMISSION_FAILED"] as const) {
      expect(isDeliveryLocked(s, []), s).toBe(false);
    }
  });

  it("locks whenever a pending or approved approval exists, whatever the status", () => {
    expect(isDeliveryLocked("PREPARING_BID", [{ status: "PENDING" }])).toBe(true);
    expect(isDeliveryLocked("SUBMISSION_FAILED", [{ status: "APPROVED" }])).toBe(true);
    for (const done of ["REJECTED", "EXPIRED", "CANCELLED"]) expect(isDeliveryLocked("PREPARING_BID", [{ status: done }])).toBe(false);
  });
});

describe("withdrawing a locked bid", () => {
  it("can reach PREPARING_BID from every withdrawable status through allowed transitions only", () => {
    const hop: Record<string, string> = {
      READY_FOR_APPROVAL: "PREPARING_BID",
      APPROVED: "SUBMITTING",
      SUBMITTING: "SUBMISSION_FAILED",
      SUBMISSION_FAILED: "READY_FOR_APPROVAL",
    };
    for (const start of DELIVERY_WITHDRAWABLE_STATUSES) {
      let at: string = start;
      for (let i = 0; i < 5 && at !== "PREPARING_BID"; i++) {
        const next = hop[at];
        expect(next, `${start} stuck at ${at}`).toBeDefined();
        expect(canTransition(at as never, next as never), `${at} -> ${next}`).toBe(true);
        at = next;
      }
      expect(at).toBe("PREPARING_BID");
    }
  });

  it("covers every locked status that can still be withdrawn, and no delivered one", () => {
    expect(DELIVERY_WITHDRAWABLE_STATUSES).toEqual(["READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMISSION_FAILED"]);
    expect(DELIVERY_WITHDRAWABLE_STATUSES.every((s) => ALL_TENDER_STATUSES.includes(s))).toBe(true);
    expect(DELIVERY_WITHDRAWABLE_STATUSES).not.toContain("SUBMITTED");
  });
});

describe("deliveryChangeSchema", () => {
  it("accepts only the four delivery fields", () => {
    expect(deliveryChangeSchema.safeParse({ submission_destination: "bids@city.gov.za", submission_method: "EMAIL" }).success).toBe(true);
    expect(deliveryChangeSchema.safeParse({ title: "x" }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({}).success).toBe(false);
  });

  it("checks each field", () => {
    expect(deliveryChangeSchema.safeParse({ submission_method: "TELEPATHY" }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ source_url: "javascript:alert(1)" }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ source_url: "ftp://x.test/f" }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ source_url: "https://city.gov.za/tender" }).success).toBe(true);
    expect(deliveryChangeSchema.safeParse({ submission_destination: "x".repeat(501) }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ closing_at: "tomorrow" }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ closing_at: "2026-11-30T12:00:00+02:00" }).success).toBe(true);
  });

  it("lets the destination and link be cleared but not the method or the closing time", () => {
    expect(deliveryChangeSchema.safeParse({ submission_destination: null, source_url: null }).success).toBe(true);
    expect(deliveryChangeSchema.safeParse({ submission_method: null }).success).toBe(false);
    expect(deliveryChangeSchema.safeParse({ closing_at: null }).success).toBe(false);
  });
});

describe("toDeliveryChanges", () => {
  const current = {
    submission_destination: "bids@city.gov.za",
    submission_method: "EMAIL",
    closing_at: "2026-11-30T10:00:00.000Z",
    source_url: "https://city.gov.za/t",
  };

  it("keeps only what differs from the current details", () => {
    expect(toDeliveryChanges(current, { ...current, submission_destination: "new@city.gov.za" })).toEqual({ submission_destination: "new@city.gov.za" });
    expect(toDeliveryChanges(current, current)).toEqual({});
  });

  it("treats a blank destination or link as clearing it, and compares closing times as instants", () => {
    expect(toDeliveryChanges(current, { ...current, submission_destination: "  ", source_url: "" })).toEqual({
      submission_destination: null,
      source_url: null,
    });
    expect(toDeliveryChanges(current, { ...current, closing_at: "2026-11-30T12:00:00+02:00" })).toEqual({});
    expect(toDeliveryChanges(current, { ...current, closing_at: "2026-12-01T12:00:00+02:00" })).toEqual({ closing_at: "2026-12-01T10:00:00.000Z" });
  });
});
