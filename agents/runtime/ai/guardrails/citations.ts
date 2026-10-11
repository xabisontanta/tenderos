import { normaliseForMatch } from "./text";

/** A quote shorter than this proves nothing, because it would match almost any document. */
export const MIN_QUOTE_CHARS = 12;

/** Text of a source document as supplied to the model, page by page. A null page means the text has no page structure. */
export interface SourceText {
  id: string;
  title: string;
  pages: Array<{ page: number | null; text: string }>;
}

export type QuoteFailure = "TOO_SHORT" | "NOT_FOUND" | "NO_SOURCE" | "MISSING_LOCATOR";

export interface QuoteCheck {
  verified: boolean;
  reason: QuoteFailure | null;
  docId: string | null;
  /** The page the quote was actually found on (null when the source has no pages or nothing was found). */
  page: number | null;
}

interface IndexedDoc {
  id: string;
  pages: Array<{ page: number | null; norm: string; start: number }>;
  joined: string;
}

/**
 * Checks model quotes against the text the model was given. A quote counts
 * only if it occurs there verbatim after whitespace, case and quote-mark
 * normalisation (AGENTS.md section 13: nothing from a document is trusted
 * unless it can be traced back to it).
 */
export class SourceIndex {
  private readonly docs: IndexedDoc[];

  constructor(sources: SourceText[]) {
    this.docs = sources.map((s) => {
      let joined = "";
      const pages = s.pages.map((p) => {
        const norm = normaliseForMatch(p.text);
        joined += (joined ? " " : "") + norm;
        return { page: p.page, norm, start: joined.length - norm.length };
      });
      return { id: s.id, pages, joined };
    });
  }

  verify(quote: string, hint: { docId?: string | null; page?: number | null } = {}): QuoteCheck {
    const fail = (reason: QuoteFailure): QuoteCheck => ({ verified: false, reason, docId: null, page: null });
    const q = normaliseForMatch(quote);
    if (q.length < MIN_QUOTE_CHARS) return fail("TOO_SHORT");
    const candidates = hint.docId ? this.docs.filter((d) => d.id === hint.docId) : this.docs;
    if (candidates.length === 0) return fail("NO_SOURCE");

    for (const d of candidates) {
      const hinted = hint.page != null ? d.pages.find((p) => p.page === hint.page) : undefined;
      if (hinted?.norm.includes(q)) return { verified: true, reason: null, docId: d.id, page: hinted.page };
      const onPage = d.pages.find((p) => p.norm.includes(q));
      if (onPage) return { verified: true, reason: null, docId: d.id, page: onPage.page };
      const at = d.joined.indexOf(q);
      if (at >= 0) {
        const startPage = [...d.pages].reverse().find((p) => p.start <= at);
        return { verified: true, reason: null, docId: d.id, page: startPage?.page ?? null };
      }
    }
    return fail("NOT_FOUND");
  }
}

export interface CitationClaim {
  document_id: string | null;
  quote: string;
  page: number | null;
  section: string | null;
}

/**
 * A citation is good when its quote is verbatim in the named source and the
 * claim has a page or section. A page the source itself can supply is filled
 * in; text with no pages needs a section from the model.
 */
export function checkCitation(index: SourceIndex, claim: CitationClaim): QuoteCheck {
  const found = index.verify(claim.quote, { docId: claim.document_id, page: claim.page });
  if (!found.verified) return found;
  if (found.page == null && !(claim.section && claim.section.trim())) return { ...found, verified: false, reason: "MISSING_LOCATOR" };
  return found;
}
