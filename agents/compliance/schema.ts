import { z } from "zod";

export const complianceItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.string(),
  mandatory: z.boolean(),
  status: z.enum(["VALID", "EXPIRED", "EXPIRING_SOON", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]),
  evidence: z.string(),
});

export const complianceOutputSchema = z.object({
  outcome: z.enum(["COMPLETE", "INCOMPLETE"]),
  items: z.array(complianceItemSchema),
  missing: z.array(z.string()),
  simulated: z.boolean(),
  /** True when a simulation run continued past missing items that would block a live run. */
  continued_in_simulation: z.boolean(),
});
export type ComplianceOutput = z.infer<typeof complianceOutputSchema>;
export type ComplianceItem = z.infer<typeof complianceItemSchema>;
