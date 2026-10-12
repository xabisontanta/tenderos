import type { TenderSnapshot } from "@/agents/runtime/types";
import type { AnalysisOutput, ExtractionItem, Requirement } from "./schema";
import { formatSast } from "@/lib/format";
import { checkCitation, type QuoteFailure, type SourceIndex } from "@/agents/runtime/ai/guardrails/citations";
import { normaliseForMatch } from "@/agents/runtime/ai/guardrails/text";

/**
 * Extracts requirements from the structured tender record only. Every
 * requirement cites the record field it came from. Documents are read by the
 * AI executor (real.ts); when none were available that is reported as a gap
 * rather than guessed.
 */
export function extractRecordRequirements(t: TenderSnapshot, opts: { documentsRead?: boolean } = {}): Pick<AnalysisOutput, "requirements" | "gaps"> {
  const reqs: Requirement[] = [];
  const gaps: string[] = [];
  const rec = (field: string) => ({ kind: "TENDER_RECORD" as const, field });

  reqs.push({
    id: "closing",
    category: "DEADLINE",
    text: `Submission closes ${formatSast(t.closing_at)}`,
    mandatory: true,
    status: "EXTRACTED",
    source: rec("closing_at"),
  });

  if (t.briefing_compulsory) {
    reqs.push({
      id: "briefing",
      category: "BRIEFING",
      text: t.briefing_at
        ? `Compulsory briefing at ${formatSast(t.briefing_at)}${t.briefing_location ? `, ${t.briefing_location}` : ""}`
        : "Compulsory briefing: date not recorded",
      mandatory: true,
      status: t.briefing_at ? "EXTRACTED" : "MISSING_INFORMATION",
      source: rec("briefing_at"),
    });
  }

  if (t.questions_deadline_at) {
    reqs.push({
      id: "questions",
      category: "DEADLINE",
      text: `Questions close ${formatSast(t.questions_deadline_at)}`,
      mandatory: false,
      status: "EXTRACTED",
      source: rec("questions_deadline_at"),
    });
  }

  reqs.push({
    id: "submission_method",
    category: "SUBMISSION",
    text:
      t.submission_method === "UNKNOWN"
        ? "Submission method not recorded"
        : `Submit via ${t.submission_method.replaceAll("_", " ").toLowerCase()}${t.submission_destination ? ` to ${t.submission_destination}` : ""}`,
    mandatory: true,
    status: t.submission_method === "UNKNOWN" ? "MISSING_INFORMATION" : "EXTRACTED",
    source: rec("submission_method"),
  });

  if (!t.description) gaps.push("No scope description on the tender record");
  if (!opts.documentsRead) gaps.push("No tender documents ingested; forms, evaluation criteria and mandatory conditions cannot be extracted yet");
  return { requirements: reqs, gaps };
}

// ---------------------------------------------------------------------------
// Checking what the model extracted (AGENTS.md section 13)
// ---------------------------------------------------------------------------

export interface CitationSources {
  index: SourceIndex;
  /** Ids of the documents that were supplied. */
  docIds: ReadonlySet<string>;
  /** Documents sent as PDF only: no text layer, so their quotes cannot be checked. */
  unverifiable: ReadonlySet<string>;
  /** Normalised text of instruction-like passages found in the documents. */
  injectionMatches: readonly string[];
}

export interface CitedEntry {
  requirement: Requirement;
  dateKind: ExtractionItem["date_kind"];
  /** Parsed `date_iso` in milliseconds, when it was a complete date with an offset. */
  dateMs: number | null;
  documentId: string;
}

const MAX_TEXT = 500;

const FAILURE_TEXT: Record<QuoteFailure, string> = {
  TOO_SHORT: "The quote is too short to prove anything",
  NOT_FOUND: "The quote was not found in the supplied document text",
  NO_SOURCE: "The cited document was not supplied",
  MISSING_LOCATOR: "The document has no page numbers and no section was given",
};

function parseDate(iso: string | null): number | null {
  if (!iso || !/(Z|[+-]\d{2}:?\d{2})$/.test(iso.trim())) return null;
  const ms = Date.parse(iso.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Turns model items into requirements. An item counts as EXTRACTED only if
 * its quote occurs verbatim in the supplied text (after whitespace
 * normalisation) and it has a page or section; anything else is kept for a
 * person but marked REQUIRES_CONFIRMATION with the reason. A quote that
 * contains an instruction-like passage is never trusted, even if it is
 * physically in the document.
 */
export function citeItems(items: ExtractionItem[], sources: CitationSources, firstNumber: number): CitedEntry[] {
  return items.map((item, i): CitedEntry => {
    let status: Requirement["status"] = "EXTRACTED";
    let warning: string | undefined;
    let verified = false;
    let page: number | undefined;

    if (!sources.docIds.has(item.document_id)) {
      status = "REQUIRES_CONFIRMATION";
      warning = FAILURE_TEXT.NO_SOURCE;
    } else if (sources.unverifiable.has(item.document_id)) {
      status = "REQUIRES_CONFIRMATION";
      warning = "Read from a PDF without a text layer, so the quote could not be checked against the document";
    } else {
      const check = checkCitation(sources.index, { document_id: item.document_id, quote: item.quote, page: item.page, section: item.section });
      if (check.verified) {
        verified = true;
        if (check.page != null) page = check.page;
      } else {
        status = "REQUIRES_CONFIRMATION";
        warning = FAILURE_TEXT[check.reason ?? "NOT_FOUND"];
      }
    }

    const normQuote = normaliseForMatch(item.quote);
    if (sources.injectionMatches.some((m) => m && normQuote.includes(m))) {
      status = "REQUIRES_CONFIRMATION";
      warning = "The quoted text reads like an instruction to an AI system and was not trusted as a tender requirement";
    }

    const dateMs = parseDate(item.date_iso);
    return {
      documentId: item.document_id,
      dateKind: item.date_kind,
      dateMs,
      requirement: {
        id: `doc-${firstNumber + i}`,
        category: item.category,
        text: item.text.trim().slice(0, MAX_TEXT),
        mandatory: item.mandatory,
        status,
        source: {
          kind: "TENDER_DOCUMENT",
          document_id: item.document_id,
          ...(page !== undefined ? { page } : {}),
          ...(item.section.trim() ? { section: item.section.trim().slice(0, 120) } : {}),
          quote: item.quote.trim().slice(0, 1000),
          quote_verified: verified,
        },
        ...(dateMs !== null ? { date_iso: new Date(dateMs).toISOString() } : {}),
        ...(warning ? { warning } : {}),
      },
    };
  });
}

/** Removes repeats of the same quote from the same document (the same clause can appear in two parts). */
export function dedupeEntries(entries: CitedEntry[]): CitedEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.documentId}|${e.requirement.category}|${normaliseForMatch(e.requirement.source.quote ?? e.requirement.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const DATE_TOLERANCE_MS = 60_000;
const RECORD_FIELD = { CLOSING: "closing_at", BRIEFING: "briefing_at", QUESTIONS: "questions_deadline_at" } as const;
const RECORD_REQ_ID = { CLOSING: "closing", BRIEFING: "briefing", QUESTIONS: "questions" } as const;
const KIND_LABEL = { CLOSING: "Closing date", BRIEFING: "Briefing date", QUESTIONS: "Questions deadline" } as const;

/**
 * Compares dates the model read with the tender record and with each other.
 * Conflicts are never resolved by picking one: every conflicting item and the
 * record's own requirement go to REQUIRES_CONFIRMATION and a gap says why.
 */
export function checkDates(entries: CitedEntry[], recordReqs: Requirement[], t: TenderSnapshot, titles: ReadonlyMap<string, string>): string[] {
  const gaps: string[] = [];
  const mark = (r: Requirement, why: string) => {
    r.status = "REQUIRES_CONFIRMATION";
    r.warning = r.warning ?? why;
  };
  for (const kind of ["CLOSING", "BRIEFING", "QUESTIONS"] as const) {
    const dated = entries.filter((e) => e.dateKind === kind && e.dateMs !== null);
    if (dated.length === 0) continue;

    const distinct = dated.filter((e, i) => dated.findIndex((o) => Math.abs((o.dateMs as number) - (e.dateMs as number)) <= DATE_TOLERANCE_MS) === i);
    if (distinct.length > 1) {
      const list = distinct.map((e) => `${formatSast(new Date(e.dateMs as number).toISOString())} ("${titles.get(e.documentId) ?? e.documentId}")`).join(" and ");
      gaps.push(`The documents give different ${KIND_LABEL[kind].toLowerCase()}s: ${list}. Confirm which applies before bidding`);
      for (const e of dated) mark(e.requirement, `The documents disagree about the ${KIND_LABEL[kind].toLowerCase()}`);
    }

    const recordIso = t[RECORD_FIELD[kind]];
    const recordMs = recordIso ? Date.parse(recordIso) : null;
    if (recordMs === null) continue;
    for (const e of dated) {
      if (Math.abs((e.dateMs as number) - recordMs) <= DATE_TOLERANCE_MS) continue;
      gaps.push(
        `${KIND_LABEL[kind]} in "${titles.get(e.documentId) ?? e.documentId}" (${formatSast(new Date(e.dateMs as number).toISOString())}) differs from the tender record (${formatSast(recordIso)}). Confirm which applies`,
      );
      mark(e.requirement, `The ${KIND_LABEL[kind].toLowerCase()} differs from the tender record`);
      const own = recordReqs.find((r) => r.id === RECORD_REQ_ID[kind]);
      if (own) mark(own, `A tender document gives a different ${KIND_LABEL[kind].toLowerCase()}`);
    }
  }
  return gaps;
}
