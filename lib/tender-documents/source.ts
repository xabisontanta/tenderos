import { Buffer } from "node:buffer";
import type { Pool } from "@/lib/db/pool";
import { NonRetryableError } from "@/agents/runtime/types";
import type { DocumentSource, TenderDocument } from "@/agents/runtime/ai/documents";
import { ingestTenderDocuments, type IngestDeps } from "./ingest";
import { selectDocumentsForAnalysis, type SelectionLimits } from "./select";
import { displayFileName } from "./sniff";

interface Row {
  id: string;
  file_name: string;
  status: "PENDING" | "DOWNLOADED" | "FAILED" | "UNSUPPORTED" | "TOO_LARGE";
  error: string | null;
  size_bytes: number | null;
  page_count: number | null;
  storage_path: string | null;
}

export interface TenderDocumentSourceOptions {
  pool: Pool;
  ingest: IngestDeps;
  limits?: SelectionLimits;
  /** How long the analysis waits for documents that are not fetched yet before it reads what it has. */
  fetchBudgetMs?: number;
}

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const label = (r: Row) => `"${displayFileName(r.file_name)}"`;

/** The reason a document was not read, as one sentence for the analysis to report. */
function gapFor(r: Row): string | null {
  switch (r.status) {
    case "DOWNLOADED":
      return null;
    case "PENDING":
      return `${label(r)} was still being fetched from the portal and was not read`;
    case "FAILED":
      return `${label(r)} could not be fetched${r.error ? `: ${r.error}` : ""}`;
    case "TOO_LARGE":
      return `${label(r)} is over the size limit and was not fetched`;
    case "UNSUPPORTED":
      return `${label(r)} was not read${r.error ? `: ${r.error}` : ""}`;
  }
}

/**
 * The Tender Analyst's documents: the tender's stored PDFs, as PDF document blocks. Before reading it makes sure the
 * portal's documents are listed and fetched (the same ingestion as the queued job, one run per tender at a time), then picks
 * documents in a fixed priority order within the size and count limits (select.ts) and reports every document that was
 * not read, whatever the reason, so the analysis never looks more complete than it was. The AI layer reaches this only
 * from the Tender Analyst's model-backed executor, which runs only when the organisation has switched AI on.
 */
export function createTenderDocumentSource(opts: TenderDocumentSourceOptions): DocumentSource {
  const { pool, ingest } = opts;

  async function ensureFetched(tenderId: string, signal: AbortSignal): Promise<void> {
    await pool.query(`select private.queue_tender_documents($1, true)`, [tenderId]);
    const until = Date.now() + (opts.fetchBudgetMs ?? 120_000);
    for (;;) {
      const res = await ingestTenderDocuments(pool, tenderId, ingest, { signal, budgetMs: Math.max(0, until - Date.now()) });
      if (!res.busy) return;
      // Another run (the queued job) is fetching: wait for it to finish rather than fetch the same files twice.
      const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from public.tender_documents where tender_id = $1 and status = 'PENDING'`, [
        tenderId,
      ]);
      if (rows[0].n === 0 || Date.now() >= until || signal.aborted) return;
      await sleep(POLL_MS);
    }
  }

  async function read(tenderId: string, signal: AbortSignal): Promise<{ documents: TenderDocument[]; gaps: string[] }> {
    await ensureFetched(tenderId, signal);
    const { rows } = await pool.query<Row>(
      `select id, file_name, status, error, size_bytes, page_count, storage_path from public.tender_documents where tender_id = $1 order by created_at, id`,
      [tenderId],
    );
    const stored = rows.filter((r) => r.status === "DOWNLOADED" && r.storage_path && r.size_bytes !== null);
    const selection = selectDocumentsForAnalysis(
      stored.map((r) => ({ id: r.id, file_name: r.file_name, size_bytes: Number(r.size_bytes), page_count: r.page_count })),
      opts.limits,
    );
    const gaps = [...rows.map(gapFor).filter((g): g is string => g !== null), ...selection.gaps];

    const byId = new Map(stored.map((r) => [r.id, r]));
    const documents: TenderDocument[] = [];
    for (const chosen of selection.chosen) {
      const row = byId.get(chosen.id)!;
      try {
        const bytes = await ingest.storage.get(row.storage_path!);
        documents.push({ id: row.id, title: displayFileName(row.file_name), pdfBase64: Buffer.from(bytes).toString("base64") });
      } catch (err) {
        if (err instanceof NonRetryableError) throw err;
        gaps.push(`${label(row)} could not be read from storage and was not analysed`);
      }
    }
    return { documents, gaps };
  }

  return {
    async listTenderDocuments(tenderId, { signal }) {
      return (await read(tenderId, signal)).documents;
    },
    readTenderDocuments: (tenderId, { signal }) => read(tenderId, signal),
  };
}
