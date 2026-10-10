import type { Database } from "@/types/database";

type SubmissionMethod = Database["public"]["Enums"]["submission_method"];

/** Normalised tender metadata a connector returns. Unknown values stay null; never guessed. */
export interface SourceTender {
  externalId: string;
  referenceNumber: string | null;
  title: string;
  issuingOrganisation: string;
  description: string | null;
  province: string | null;
  sector: string | null;
  estimatedValueZar: number | null;
  publishedAt: string | null;
  closingAt: string;
  briefingAt: string | null;
  briefingCompulsory: boolean | null;
  submissionMethod: SubmissionMethod;
  sourceUrl: string;
}

export interface SourceDocument {
  externalId: string;
  fileName: string;
  url: string;
  mimeType: string | null;
}

export interface SearchQuery {
  keywords?: string[];
  provinces?: string[];
  categories?: string[];
  closingAfter?: string;
  page?: number;
}

/**
 * Abstraction over a tender source (national portal, municipal site, email
 * feed). Connectors must use official APIs or structured public data and
 * respect each portal's terms; browser automation, if ever needed, lives
 * behind this interface.
 */
export interface TenderSourceConnector {
  readonly slug: string;
  readonly displayName: string;
  search(query: SearchQuery): Promise<{ tenders: SourceTender[]; nextPage: number | null }>;
  getTender(externalId: string): Promise<SourceTender | null>;
  getDocuments(externalId: string): Promise<SourceDocument[]>;
  getAmendments(externalId: string): Promise<SourceDocument[]>;
  getAward(externalId: string): Promise<{ awarded: boolean; supplier: string | null; value: number | null } | null>;
  supportsSubmission(): boolean;
}
