import { z } from "zod";

/** A paragraph of draft text and the facts and tender requirements it rests on. */
export const proposalParagraphSchema = z.object({
  text: z.string().describe("One paragraph of plain prose, no headings or markdown, using only what the cited facts and requirements say"),
  fact_ids: z.array(z.string()).describe("Ids of the company facts relied on, exactly as written in brackets, such as fact:cidb_grade"),
  requirement_ids: z.array(z.string()).describe("Ids of the tender requirements the paragraph addresses, exactly as written in brackets"),
});

export const proposalSectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: z.enum(["DRAFTED", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]),
  /** Draft text. Null when the facts needed are not on file; never invented. */
  content: z.string().nullable(),
  needs: z.array(z.string()),
  /** The paragraphs behind `content`, each with the facts and requirements it cites. */
  paragraphs: z.array(proposalParagraphSchema).optional(),
  /** Why a person must look at this section, for example text that was removed. */
  warnings: z.array(z.string()).optional(),
});

export const proposalOutputSchema = z.object({
  sections: z.array(proposalSectionSchema),
  open_items: z.number().int().min(0),
  simulated: z.boolean(),
  /** True when a model wrote any of the text. It is a draft for a person to review. */
  ai_generated: z.boolean().optional(),
});
export type ProposalOutput = z.infer<typeof proposalOutputSchema>;
export type ProposalSection = z.infer<typeof proposalSectionSchema>;

// What the model fills in. Titles come from the fixed outline, not from the model.
export const proposalModelSchema = z.object({
  sections: z.array(
    z.object({
      key: z.string().describe("The key of one outline section"),
      status: z.enum(["DRAFTED", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]).describe("MISSING_INFORMATION when the facts do not support any text for this section"),
      paragraphs: z.array(proposalParagraphSchema),
      needs: z.array(z.string()).describe("Facts or documents a person must supply for this section to be complete"),
    }),
  ),
});
export type ProposalModel = z.infer<typeof proposalModelSchema>;
