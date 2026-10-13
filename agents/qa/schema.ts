import { z } from "zod";

export const qaCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  result: z.enum(["PASS", "FAIL", "OPEN_ISSUE"]),
  detail: z.string(),
  /** What the check relies on, such as section:methodology or compliance:tax_compliance. */
  evidence_refs: z.array(z.string()).optional(),
});

export const qaOutputSchema = z.object({
  verdict: z.enum(["PASS", "CONDITIONAL", "FAIL"]),
  checks: z.array(qaCheckSchema),
  open_issues: z.array(z.string()),
  simulated: z.boolean(),
  /** True when a model took part in the review. It can add open issues; it cannot remove one or fail a bid. */
  ai_generated: z.boolean().optional(),
  /** Why the AI review was not run. */
  ai_note: z.string().optional(),
});
export type QaOutput = z.infer<typeof qaOutputSchema>;
export type QaCheck = z.infer<typeof qaCheckSchema>;

// What the model fills in.
export const qaModelSchema = z.object({
  coverage: z.array(
    z.object({
      requirement_id: z.string().describe("The id of a requirement, exactly as written in brackets"),
      result: z.enum(["ADDRESSED", "PARTIALLY_ADDRESSED", "NOT_ADDRESSED", "CANNOT_DETERMINE"]),
      evidence_refs: z.array(z.string()).describe("The bracketed ids of the bid content that addresses it, such as section:executive_summary or compliance:cidb_grading; empty if none"),
      detail: z.string().describe("One sentence on why"),
    }),
  ),
  inconsistencies: z.array(
    z.object({
      detail: z.string().describe("A contradiction between parts of the bid, or between the bid and the tender requirements"),
      refs: z.array(z.string()).describe("The bracketed ids involved"),
    }),
  ),
  other_issues: z.array(z.string()).describe("Anything else a person approving the bid should check"),
});
export type QaModel = z.infer<typeof qaModelSchema>;
