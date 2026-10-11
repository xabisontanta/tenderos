import { sanitiseSourceText } from "./guardrails/text";

/** A tender document as a source delivers it. Real downloading and text extraction arrive with document ingestion. */
export interface TenderDocument {
  /** Stable id; quotes cite it. */
  id: string;
  title: string;
  /** Extracted text per page (1-based). */
  pages?: Array<{ page: number; text: string }>;
  /** Extracted text without page structure. */
  text?: string;
  /** The original PDF, base64. Shown to the model for layout and tables; quotes can only be verified against `pages` or `text`. */
  pdfBase64?: string;
}

export interface DocumentSource {
  listTenderDocuments(tenderId: string, opts: { signal: AbortSignal }): Promise<TenderDocument[]>;
}

/** The source used until ingestion lands: a tender has no documents. */
export const NO_DOCUMENTS: DocumentSource = { async listTenderDocuments() { return []; } };

/** Largest PDF sent as a document block (the API allows 32 MB per request, base64 included). */
export const MAX_PDF_BASE64_CHARS = 24 * 1024 * 1024;

export interface PreparedPage {
  page: number | null;
  text: string;
}

/** A document in the form that is both shown to the model and checked against its quotes. */
export interface PreparedDocument {
  id: string;
  title: string;
  pages: PreparedPage[];
  pdfBase64: string | null;
  chars: number;
}

export function prepareDocument(doc: TenderDocument): PreparedDocument {
  let pages: PreparedPage[] = [];
  if (doc.pages?.length) {
    pages = [...doc.pages]
      .sort((a, b) => a.page - b.page)
      .map((p) => ({ page: p.page, text: sanitiseSourceText(p.text) }))
      .filter((p) => p.text.trim() !== "");
  } else if (doc.text && doc.text.trim() !== "") {
    pages = [{ page: null, text: sanitiseSourceText(doc.text) }];
  }
  return {
    id: doc.id,
    title: sanitiseSourceText(doc.title).replace(/\s+/g, " ").trim().slice(0, 200),
    pages,
    pdfBase64: doc.pdfBase64 ?? null,
    chars: pages.reduce((n, p) => n + p.text.length, 0),
  };
}

export interface DocumentChunk {
  docId: string;
  title: string;
  pages: PreparedPage[];
  /** 1-based position among the chunks of the document. */
  part: number;
  parts: number;
}

const SEP = 2; // "\n\n" between pieces of the same page

/** Splits text into pieces of at most `max` characters, at paragraph boundaries where possible. */
function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current) pieces.push(current);
    current = "";
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    let rest = paragraph;
    while (rest.length > max) {
      flush();
      const window = rest.slice(0, max);
      const cut = window.search(/\s\S*$/);
      const at = cut > max * 0.8 ? cut : max;
      pieces.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (!rest) continue;
    if (current && current.length + SEP + rest.length > max) flush();
    current = current ? `${current}\n\n${rest}` : rest;
  }
  flush();
  return pieces;
}

/** Divides a document into parts that each fit one request. Nothing is dropped. */
export function chunkDocument(doc: PreparedDocument, maxChars: number): DocumentChunk[] {
  const units: PreparedPage[] = doc.pages.flatMap((p) => splitText(p.text, maxChars).map((text) => ({ page: p.page, text })));
  const groups: PreparedPage[][] = [];
  let current: PreparedPage[] = [];
  let size = 0;
  for (const u of units) {
    const last = current[current.length - 1];
    const joins = last !== undefined && last.page !== null && last.page === u.page;
    const add = u.text.length + (joins ? SEP : 0);
    if (current.length > 0 && size + add > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    const tail = current[current.length - 1];
    if (tail && tail.page !== null && tail.page === u.page) {
      tail.text = `${tail.text}\n\n${u.text}`;
      size += u.text.length + SEP;
    } else {
      current.push({ page: u.page, text: u.text });
      size += u.text.length;
    }
  }
  if (current.length) groups.push(current);
  return groups.map((pages, i) => ({ docId: doc.id, title: doc.title, pages, part: i + 1, parts: groups.length }));
}

/** Chunk text as the model sees it: page markers sit outside the text that quotes are checked against. */
export function renderChunk(chunk: DocumentChunk): string {
  return chunk.pages.map((p) => (p.page === null ? p.text : `=== PAGE ${p.page} ===\n${p.text}`)).join("\n\n");
}
