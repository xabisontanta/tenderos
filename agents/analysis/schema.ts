import { z } from "zod";

const sourceRef = z.object({
  kind: z.enum(["TENDER_RECORD", "TENDER_DOCUMENT"]),
  field: z.string().optional(),
  document_id: z.string().optional(),
  page: z.number().int().optional(),
});

export const requirementSchema = z.object({
  id: z.string(),
  category: z.enum(["DEADLINE", "BRIEFING", "SUBMISSION", "MANDATORY_CONDITION", "DOCUMENT", "SCOPE", "PRICING", "EVALUATION"]),
  text: z.string(),
  mandatory: z.boolean(),
  status: z.enum(["EXTRACTED", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]),
  source: sourceRef,
});

export const analysisOutputSchema = z.object({
  requirements: z.array(requirementSchema),
  documents_analysed: z.number().int().min(0),
  gaps: z.array(z.string()),
  simulated: z.boolean(),
});
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
