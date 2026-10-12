import { z } from "zod";
import type { TenderStatus } from "./tender-state";

/**
 * Delivery details (destination, method, source link, closing time) are locked while a bid is waiting for
 * approval or delivery. Mirrors private.delivery_locked() in migration 055; tests/integration/delivery-lock.test.ts
 * asserts the two agree for every status.
 */
export const DELIVERY_LOCKED_STATUSES: readonly TenderStatus[] = ["READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED"];

/** Locked statuses from which change_tender_delivery can still withdraw the bid; a delivered bid cannot be withdrawn. */
export const DELIVERY_WITHDRAWABLE_STATUSES: readonly TenderStatus[] = ["READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMISSION_FAILED"];

export function isDeliveryLocked(status: TenderStatus, approvals: ReadonlyArray<{ status: string }>): boolean {
  return DELIVERY_LOCKED_STATUSES.includes(status) || approvals.some((a) => a.status === "PENDING" || a.status === "APPROVED");
}

const METHODS = ["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"] as const;

/** The `changes` an owner or admin may send to change_tender_delivery: only these keys, each checked. */
export const deliveryChangeSchema = z
  .object({
    submission_destination: z.string().trim().max(500, "The destination is too long").nullable().optional(),
    submission_method: z.enum(METHODS).optional(),
    closing_at: z.iso.datetime({ offset: true, message: "Enter a valid closing date and time" }).optional(),
    source_url: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => /^https?:\/\//i.test(v), "The source link must start with http:// or https://")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Change at least one detail");

export interface DeliveryDetails {
  submission_destination: string | null;
  submission_method: string;
  closing_at: string;
  source_url: string | null;
}

const blankToNull = (v: string | null) => (v === null || v.trim() === "" ? null : v.trim());

/** What differs between the details on file and the form, as the `changes` object (blank text clears). */
export function toDeliveryChanges(current: DeliveryDetails, next: DeliveryDetails): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  if (blankToNull(next.submission_destination) !== blankToNull(current.submission_destination))
    changes.submission_destination = blankToNull(next.submission_destination);
  if (next.submission_method !== current.submission_method) changes.submission_method = next.submission_method;
  if (new Date(next.closing_at).getTime() !== new Date(current.closing_at).getTime()) changes.closing_at = new Date(next.closing_at).toISOString();
  if (blankToNull(next.source_url) !== blankToNull(current.source_url)) changes.source_url = blankToNull(next.source_url);
  return changes;
}
