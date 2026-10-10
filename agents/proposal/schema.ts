import { z } from "zod";

export const proposalSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum(["DRAFTED", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]),
  /** Draft text. Null when the facts needed are not on file; never invented. */
  content: z.string().nullable(),
  needs: z.array(z.string()),
});

export const proposalOutputSchema = z.object({
  sections: z.array(proposalSectionSchema),
  open_items: z.number().int().min(0),
  simulated: z.boolean(),
});
export type ProposalOutput = z.infer<typeof proposalOutputSchema>;
