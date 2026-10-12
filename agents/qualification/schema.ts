import { z } from "zod";

export const factorSchema = z.object({
  key: z.string(),
  label: z.string(),
  result: z.enum(["PASS", "WARN", "FAIL", "REQUIRES_CONFIRMATION"]),
  hard_disqualifier: z.boolean(),
  evidence: z.string(),
});

// What the model fills in for the fit assessment.
export const aiFitReasonSchema = z.object({
  factor: z.enum(["SECTOR", "CIDB_GRADE", "GEOGRAPHY", "EXPERIENCE", "CAPACITY", "OTHER"]),
  assessment: z.enum(["SUPPORTS", "CONCERN", "UNKNOWN"]).describe("SUPPORTS only when a company fact backs it; UNKNOWN when the facts say nothing"),
  text: z.string().describe("One or two plain sentences"),
  fact_ids: z.array(z.string()).describe("Ids of the company facts relied on, exactly as written in brackets; empty for UNKNOWN"),
  requirement_ids: z.array(z.string()).describe("Ids of the tender requirements this addresses, exactly as written in brackets"),
});

export const aiFitModelSchema = z.object({
  score: z.number().int().min(0).max(100).describe("How well the company's recorded facts match what the tender asks. 0 means no match, 100 a full match on every point"),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).describe("LOW when the recorded facts are too thin to judge"),
  reasons: z.array(aiFitReasonSchema),
  risks: z.array(z.object({ text: z.string(), requirement_ids: z.array(z.string()) })),
  missing_information: z.array(z.string()).describe("Facts a person should add to the company profile to judge the fit properly"),
});

export const aiFitSchema = aiFitModelSchema.extend({ ai_generated: z.literal(true) });
export type AiFit = z.infer<typeof aiFitSchema>;
export type AiFitModel = z.infer<typeof aiFitModelSchema>;

export const qualificationOutputSchema = z.object({
  decision: z.enum(["QUALIFIED", "REJECTED"]),
  confirmation_required: z.boolean(),
  /** Share of assessable factors that passed, 0..100. Never overrides a hard disqualifier. */
  fit_score: z.number().min(0).max(100).nullable(),
  factors: z.array(factorSchema),
  hard_disqualifiers: z.array(z.string()),
  simulated: z.boolean(),
  /** AI fit assessment: a draft for a person to read. It never changes the decision, which the rule gates make. Null when it was not run. */
  ai_fit: aiFitSchema.nullable().optional(),
  /** Why the AI assessment was not run. */
  ai_note: z.string().optional(),
});
export type QualificationOutput = z.infer<typeof qualificationOutputSchema>;
export type QualificationFactor = z.infer<typeof factorSchema>;
