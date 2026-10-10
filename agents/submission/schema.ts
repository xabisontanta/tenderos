import { z } from "zod";

export const submissionOutputSchema = z.object({
  status: z.enum(["SUBMITTED", "ACTION_REQUIRED"]),
  method: z.enum(["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"]),
  package_hash: z.string().regex(/^[a-f0-9]{64}$/),
  destination: z.string().nullable(),
  verified: z.object({
    approval: z.boolean(),
    deadline: z.boolean(),
    reference: z.boolean(),
  }),
  /** True when nothing was sent to any external system. */
  simulated: z.boolean(),
  receipt_note: z.string(),
});
export type SubmissionOutput = z.infer<typeof submissionOutputSchema>;
