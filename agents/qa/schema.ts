import { z } from "zod";

export const qaCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  result: z.enum(["PASS", "FAIL", "OPEN_ISSUE"]),
  detail: z.string(),
});

export const qaOutputSchema = z.object({
  verdict: z.enum(["PASS", "CONDITIONAL", "FAIL"]),
  checks: z.array(qaCheckSchema),
  open_issues: z.array(z.string()),
  simulated: z.boolean(),
});
export type QaOutput = z.infer<typeof qaOutputSchema>;
export type QaCheck = z.infer<typeof qaCheckSchema>;
