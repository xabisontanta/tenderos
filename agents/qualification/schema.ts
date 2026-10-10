import { z } from "zod";

export const factorSchema = z.object({
  key: z.string(),
  label: z.string(),
  result: z.enum(["PASS", "WARN", "FAIL", "REQUIRES_CONFIRMATION"]),
  hard_disqualifier: z.boolean(),
  evidence: z.string(),
});

export const qualificationOutputSchema = z.object({
  decision: z.enum(["QUALIFIED", "REJECTED"]),
  confirmation_required: z.boolean(),
  /** Share of assessable factors that passed, 0..100. Never overrides a hard disqualifier. */
  fit_score: z.number().min(0).max(100).nullable(),
  factors: z.array(factorSchema),
  hard_disqualifiers: z.array(z.string()),
  simulated: z.boolean(),
});
export type QualificationOutput = z.infer<typeof qualificationOutputSchema>;
export type QualificationFactor = z.infer<typeof factorSchema>;
