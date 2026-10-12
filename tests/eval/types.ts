import type { ExtractionItem, Requirement } from "@/agents/analysis/schema";
import type { TenderDocument } from "@/agents/runtime/ai/documents";
import type { TenderSnapshot } from "@/agents/runtime/types";

export type CompanyKey = "civils" | "it" | "facilities" | "medical";

export type EvalTag =
  | "adversarial:prompt-injection"
  | "adversarial:missing-mandatory-documents"
  | "adversarial:conflicting-dates"
  | "adversarial:scanned-pdf"
  | "sector:construction"
  | "sector:it"
  | "sector:cleaning"
  | "sector:security"
  | "sector:medical"
  | "sector:municipal"
  | "sector:education"
  | "sector:electrical";

/** One requirement the Tender Analyst is expected to extract from the fixture's documents. */
export interface ExpectedRequirement {
  /** Stable label used in reports. */
  key: string;
  category: Requirement["category"];
  mandatory: boolean;
  document_id: string;
  /** Page the quote is on; null for documents without pages. */
  page: number | null;
  /** Clause or heading, needed for documents without pages. */
  section: string;
  /** Copied verbatim from the document text. A unit test checks that it occurs there. */
  quote: string;
  /** At least one of these (case-insensitive) must appear in the extracted requirement's text. */
  textIncludes: string[];
  /** For dated items: the date kind and the moment the document gives. */
  date?: { kind: "CLOSING" | "BRIEFING" | "QUESTIONS"; iso: string };
  /** The status the analyst must give it. REQUIRES_CONFIRMATION for items that cannot or must not be trusted. */
  status: "EXTRACTED" | "REQUIRES_CONFIRMATION";
}

/**
 * A labelled synthetic South African tender. The format is documented in
 * docs/ai-agents.md ("Evaluation fixtures"). Fixtures are invented; any
 * resemblance to a real tender or organisation is coincidental.
 */
export interface EvalFixture {
  id: string;
  title: string;
  description: string;
  tags: EvalTag[];
  /** Overrides on top of a default tender record. */
  tender: Partial<TenderSnapshot>;
  documents: TenderDocument[];
  /** What the PDF says, for PDF-only fixtures. Used to derive labels and the fake model's answer; never given to the analyst. */
  groundTruth?: { document_id: string; text: string };
  /** The company profile to use for the later steps, or null for none. */
  company: CompanyKey | null;
  expected: {
    requirements: ExpectedRequirement[];
    /** Patterns (RegExp source, case-insensitive) that no EXTRACTED requirement may match. */
    forbidden: Array<{ pattern: string; why: string }>;
    /** Substrings (case-insensitive) that must appear in the analysis gaps. */
    gaps: string[];
    /** Whether instruction-like text in the documents must be reported. */
    injectionDetected: boolean;
    /** Expected rule-gate outcome of the Qualification Agent. */
    qualification: { decision: "QUALIFIED" | "REJECTED" };
  };
  /** Gaps a faithful model reports itself, such as an annexure that is referred to but missing. */
  modelGaps?: string[];
  /** What a model that obeys the document instead of the system prompt would also return. Used by the hostile-model scenario. */
  hostileModelItems?: ExtractionItem[];
}
