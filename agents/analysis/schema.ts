import { z } from "zod";

const sourceRef = z.object({
  kind: z.enum(["TENDER_RECORD", "TENDER_DOCUMENT"]),
  field: z.string().optional(),
  document_id: z.string().optional(),
  page: z.number().int().optional(),
  /** Clause or heading, for text without page numbers. */
  section: z.string().optional(),
  /** Text copied from the document. Verified against the supplied text before a requirement counts as EXTRACTED. */
  quote: z.string().optional(),
  quote_verified: z.boolean().optional(),
});

export const requirementSchema = z.object({
  id: z.string(),
  category: z.enum(["DEADLINE", "BRIEFING", "SUBMISSION", "MANDATORY_CONDITION", "DOCUMENT", "SCOPE", "PRICING", "EVALUATION"]),
  text: z.string(),
  mandatory: z.boolean(),
  status: z.enum(["EXTRACTED", "MISSING_INFORMATION", "REQUIRES_CONFIRMATION"]),
  source: sourceRef,
  /** The date the requirement states, ISO 8601 with offset, when it states one. */
  date_iso: z.string().optional(),
  /** Why a person must confirm this requirement. */
  warning: z.string().optional(),
});

export const injectionWarningSchema = z.object({
  document_id: z.string(),
  page: z.number().int().nullable(),
  pattern: z.string(),
  excerpt: z.string(),
});

export const analysisOutputSchema = z.object({
  requirements: z.array(requirementSchema),
  documents_analysed: z.number().int().min(0),
  gaps: z.array(z.string()),
  simulated: z.boolean(),
  /** True when a model produced part of this output. It is a draft for a person to check. */
  ai_generated: z.boolean().optional(),
  /** Text in a document that reads like an instruction to an AI system. It was treated as data. */
  injection_warnings: z.array(injectionWarningSchema).optional(),
});
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;
export type Requirement = z.infer<typeof requirementSchema>;

// What the model fills in. Built from the stored requirement schema so the categories stay in one place.
export const dateKindSchema = z.enum(["CLOSING", "BRIEFING", "QUESTIONS", "OTHER", "NONE"]);

export const extractionItemSchema = z.object({
  category: requirementSchema.shape.category,
  text: z.string().describe("The requirement in one plain sentence, in your own words"),
  mandatory: z.boolean().describe("True only if the document says must, shall, compulsory or that non-compliance disqualifies"),
  document_id: z.string().describe("The id attribute of the UNTRUSTED_DATA marker the quote comes from"),
  page: z.number().int().nullable().describe("The number in the nearest preceding '=== PAGE n ===' line; null if the document has no page markers"),
  section: z.string().describe("Clause or heading, such as 'Clause 4.2'; empty string if none"),
  quote: z.string().describe("Text copied exactly from the document: at least 12 characters, no ellipsis, no page markers, no paraphrase"),
  date_iso: z.string().nullable().describe("When the item states a date and time, that moment as ISO 8601 with the +02:00 offset; otherwise null"),
  date_kind: dateKindSchema.describe("CLOSING for the bid closing time, BRIEFING for the briefing, QUESTIONS for the clarification deadline, OTHER for any other date, NONE if there is no date"),
});

export const extractionSchema = z.object({
  items: z.array(extractionItemSchema),
  gaps: z.array(z.string()).describe("Things a bidder would expect to find but that are absent, or that conflict between documents"),
});

export type ExtractionItem = z.infer<typeof extractionItemSchema>;
export type ExtractionOutput = z.infer<typeof extractionSchema>;
