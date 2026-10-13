import { displayFileName } from "./sniff";

/** What the selection needs to know about a stored PDF. */
export interface CandidateDocument {
  id: string;
  file_name: string;
  size_bytes: number;
  /** From the page tree; null when it could not be read. */
  page_count: number | null;
}

export interface SelectionLimits {
  /** Documents sent for one tender. Each is its own request, so this is also a cost limit. */
  maxDocuments?: number;
  /** All chosen documents together, in bytes. */
  maxTotalBytes?: number;
  /** One document, in bytes: a PDF is sent base64 encoded in a single request, which the API limits to 32 MB. */
  maxPdfBytes?: number;
  /** Pages the API reads from one PDF. */
  maxPages?: number;
}

const MB = 1024 * 1024;
export const DEFAULT_LIMITS: Required<SelectionLimits> = {
  maxDocuments: 8,
  maxTotalBytes: 40 * MB,
  maxPdfBytes: 18 * MB,
  maxPages: 100,
};

export type SkipReason = "count" | "total_size" | "too_large" | "too_many_pages";

export interface Selection {
  chosen: CandidateDocument[];
  skipped: Array<{ doc: CandidateDocument; reason: SkipReason }>;
  /** One plain sentence per skipped document, for the analysis to report as a gap. */
  gaps: string[];
}

const CORE =
  /\b(invitation|bid document|bidding document|tender document|tender notice|request for (quotation|proposals?|bids?)|rfq|rfp|rfb|conditions of (tender|bid)|returnables?|sbd)\b/;
const SCOPE =
  /\b(specifications?|spec|scope|terms of reference|tor|bill of quantities|boq|pric(e|es|ing)|schedules?|evaluation|criteria|special conditions|annex(ure)?s?|appendix|appendices)\b/;
const LOW = /\b(drawings?|maps?|photos?|photographs?|brochures?|templates?|checklists?|general conditions)\b/;

/** Lower reads first: the bid document and invitation, then scope and price, then everything else, then drawings and photos. */
export function documentPriority(fileName: string): number {
  const name = (fileName.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (CORE.test(name)) return 0;
  if (LOW.test(name)) return 3;
  if (SCOPE.test(name)) return 1;
  return 2;
}

const label = (d: CandidateDocument) => `"${displayFileName(d.file_name)}"`;
const size = (bytes: number) => `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;

/**
 * Chooses which stored PDFs go to the Tender Analyst when a pack is bigger than one task should read, in an order that
 * does not depend on how the list arrives: priority, then file name, then id. A document that cannot be sent at all (too
 * big for one request, more pages than the API reads) is skipped wherever it ranks; the rest fill the document and size
 * limits in order, and every document left out is named in a gap so nobody assumes it was read.
 */
export function selectDocumentsForAnalysis(docs: readonly CandidateDocument[], limits: SelectionLimits = {}): Selection {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const ordered = [...docs].sort(
    (a, b) =>
      documentPriority(a.file_name) - documentPriority(b.file_name) ||
      displayFileName(a.file_name).toLowerCase().localeCompare(displayFileName(b.file_name).toLowerCase()) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const chosen: CandidateDocument[] = [];
  const skipped: Selection["skipped"] = [];
  const gaps: string[] = [];
  let total = 0;
  for (const doc of ordered) {
    let reason: SkipReason | null = null;
    if (doc.size_bytes > l.maxPdfBytes) reason = "too_large";
    else if (doc.page_count !== null && doc.page_count > l.maxPages) reason = "too_many_pages";
    else if (chosen.length >= l.maxDocuments) reason = "count";
    else if (total + doc.size_bytes > l.maxTotalBytes) reason = "total_size";
    if (!reason) {
      chosen.push(doc);
      total += doc.size_bytes;
      continue;
    }
    skipped.push({ doc, reason });
    gaps.push(
      {
        too_large: `${label(doc)} is ${size(doc.size_bytes)}, too large to send in one request, so it was not read`,
        too_many_pages: `${label(doc)} has ${doc.page_count} pages and the AI reads at most ${l.maxPages} pages of one document, so it was not read`,
        count: `${label(doc)} was not read: only the ${l.maxDocuments} most relevant documents are read for one tender`,
        total_size: `${label(doc)} was not read: the documents already chosen use up the size limit for one tender`,
      }[reason],
    );
  }
  return { chosen, skipped, gaps };
}
