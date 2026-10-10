import { z } from "zod";

export const intakeOutputSchema = z.object({
  tender_id: z.string().uuid(),
  hours_to_close: z.number(),
  plan: z.array(z.object({ step: z.string(), agent: z.string(), title: z.string() })).min(1),
  missing_fields: z.array(z.string()),
  warnings: z.array(z.string()),
  simulated: z.boolean(),
});
export type IntakeOutput = z.infer<typeof intakeOutputSchema>;
