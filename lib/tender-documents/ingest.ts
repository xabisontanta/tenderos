import type { Pool, PoolClient } from "@/lib/db/pool";
import type { Logger } from "@/lib/log";
import { NonRetryableError } from "@/agents/runtime/types";
import * as db from "@/workflows/store";
import { fetchDocumentBytes, type FetchDeps, type FetchRequest, type FetchResult } from "./fetcher";
import { classifyDownload, declaredKind, displayFileName, pdfFacts } from "./sniff";
import { documentHostAllowList } from "./policy";
import { tenderDocumentPath, type DocumentStorage } from "./storage";
import { defaultFetchDeps } from "./transport";

/** A document is tried this many times before it is marked FAILED and left for a person to retry. */
export const MAX_FETCH_ATTEMPTS = 3;
/** Stop starting new downloads after this long in one job; the rest waits for the next run. */
const JOB_BUDGET_MS = 90_000;

export interface IngestDeps {
  /** Downloads one document. Production: the hardened HTTPS fetcher. Tests: a fake. */
  fetch(req: FetchRequest): Promise<FetchResult>;
  storage: DocumentStorage;
  logger: Logger;
  /** Hosts allowed besides the tender's own. Defaults to TENDER_DOCUMENT_HOSTS. */
  allowedHosts?: readonly string[];
}

export interface IngestResult {
  downloaded: number;
  unsupported: number;
  tooLarge: number;
  failed: number;
  /** Documents put back to PENDING after a failure that another attempt may fix. */
  retrying: number;
  /** Documents still PENDING because the time budget ran out. */
  remaining: number;
  /** Another run holds the tender's lock; nothing was done. */
  busy: boolean;
}

const EMPTY: IngestResult = { downloaded: 0, unsupported: 0, tooLarge: 0, failed: 0, retrying: 0, remaining: 0, busy: false };

/** The production dependencies: the hardened fetcher and Supabase Storage with the service role key. */
export function productionIngestDeps(logger: Logger, storage: DocumentStorage, fetchDeps: FetchDeps = defaultFetchDeps()): IngestDeps {
  return { fetch: (req) => fetchDocumentBytes(req, fetchDeps), storage, logger };
}

interface Row {
  id: string;
  source_url: string;
  file_name: string;
  attempts: number;
}

/**
 * Fetches every PENDING document of a tender: downloads it, checks the bytes against the declared type, stores PDFs in the
 * private bucket and records the outcome on the row. One run per tender at a time (an advisory lock), so the queued job and
 * the Tender Analyst never fetch the same file twice. Every document gets its own outcome; one bad file never stops the rest.
 * Nothing about a document's URL or content goes to the log.
 */
export async function ingestTenderDocuments(
  pool: Pool,
  tenderId: string,
  deps: IngestDeps,
  opts: { signal?: AbortSignal; budgetMs?: number; now?: () => number } = {},
): Promise<IngestResult> {
  const now = opts.now ?? Date.now;
  const lockClient = await pool.connect();
  try {
    const { rows: lock } = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtextextended('tender-documents:' || $1::text, 0)) as ok`, [
      tenderId,
    ]);
    if (!lock[0].ok) return { ...EMPTY, busy: true };
    try {
      return await run(pool, lockClient, tenderId, deps, opts.signal, now() + (opts.budgetMs ?? JOB_BUDGET_MS), now);
    } finally {
      await lockClient.query(`select pg_advisory_unlock(hashtextextended('tender-documents:' || $1::text, 0))`, [tenderId]).catch(() => undefined);
    }
  } finally {
    lockClient.release();
  }
}

async function run(
  pool: Pool,
  c: PoolClient,
  tenderId: string,
  deps: IngestDeps,
  signal: AbortSignal | undefined,
  until: number,
  now: () => number,
): Promise<IngestResult> {
  const { rows: tenders } = await c.query<{ organisation_id: string; source_url: string | null; is_simulation: boolean }>(
    `select organisation_id, source_url, is_simulation from public.tenders where id = $1`,
    [tenderId],
  );
  const tender = tenders[0];
  if (!tender || tender.is_simulation) return { ...EMPTY };
  const allowedHosts = deps.allowedHosts ?? documentHostAllowList();
  const { rows } = await c.query<Row>(
    `select id, source_url, file_name, attempts from public.tender_documents where tender_id = $1 and status = 'PENDING' order by created_at, file_name, id`,
    [tenderId],
  );
  const result: IngestResult = { ...EMPTY };
  for (const [i, row] of rows.entries()) {
    if (signal?.aborted || now() >= until) {
      result.remaining = rows.length - i;
      break;
    }
    const outcome = await processOne(pool, tender, tenderId, row, deps, allowedHosts, signal);
    result[outcome]++;
  }
  const handled = result.downloaded + result.unsupported + result.tooLarge + result.failed + result.retrying;
  if (handled > 0) await announce(c, tender.organisation_id, tenderId, result);
  return result;
}

type Outcome = "downloaded" | "unsupported" | "tooLarge" | "failed" | "retrying";

async function processOne(
  pool: Pool,
  tender: { organisation_id: string; source_url: string | null },
  tenderId: string,
  row: Row,
  deps: IngestDeps,
  allowedHosts: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const name = displayFileName(row.file_name);
  const log = deps.logger.child({ tender_id: tenderId, document_id: row.id });
  const finish = async (
    fields: {
      status: string;
      error?: string | null;
      sha256?: string | null;
      size?: number | null;
      pages?: number | null;
      mime?: string | null;
      path?: string | null;
    },
    attempts = row.attempts,
  ) => {
    await pool.query(
      `update public.tender_documents
          set status = $2, error = $3, sha256 = $4, size_bytes = $5, page_count = $6, mime_type = $7, storage_path = $8, attempts = $9,
              fetched_at = case when $2 = 'PENDING' then null else now() end
        where id = $1`,
      [
        row.id,
        fields.status,
        fields.error ?? null,
        fields.sha256 ?? null,
        fields.size ?? null,
        fields.pages ?? null,
        fields.mime ?? null,
        fields.path ?? null,
        attempts,
      ],
    );
  };
  /** The same content is already stored under another URL: record this one without storing or hashing it twice. */
  const duplicate = async (sha256: string, extra: { size: number; mime: string | null }): Promise<Outcome> => {
    const { rows } = await pool.query<{ file_name: string }>(
      `select file_name from public.tender_documents where tender_id = $1 and sha256 = $2 and id <> $3`,
      [tenderId, sha256, row.id],
    );
    await finish(
      {
        status: "UNSUPPORTED",
        error: `Identical to "${displayFileName(rows[0]?.file_name ?? "another document")}", which is already held; not read twice`,
        size: extra.size,
        mime: extra.mime,
      },
      row.attempts + 1,
    );
    return "unsupported";
  };

  // A type that is never read is not downloaded at all: its bytes could not be checked, and there is nothing to do with them.
  if (declaredKind(name) === "other") {
    const note = classifyDownload(name, new Uint8Array(0));
    await finish({ status: "UNSUPPORTED", error: note.outcome === "unsupported" ? note.message : null }, row.attempts);
    return "unsupported";
  }

  const got = await deps.fetch({ url: row.source_url, sourceUrl: tender.source_url, allowedHosts, signal });
  if (!got.ok) {
    log.warn("tender document not fetched", { reason: got.reason, status: got.status ?? null, retryable: got.retryable });
    if (got.reason === "too_large") {
      await finish({ status: "TOO_LARGE", error: got.message }, row.attempts + 1);
      return "tooLarge";
    }
    if (got.retryable && row.attempts + 1 < MAX_FETCH_ATTEMPTS) {
      await finish({ status: "PENDING", error: `${got.message}; will try again` }, row.attempts + 1);
      return "retrying";
    }
    await finish({ status: "FAILED", error: got.message }, row.attempts + 1);
    return "failed";
  }

  const cls = classifyDownload(name, got.bytes);
  const common = { size: got.bytes.byteLength, mime: got.contentType?.slice(0, 150) ?? null };
  try {
    if (cls.outcome === "mismatch") {
      log.warn("tender document is not what its name says", { size: common.size });
      await finish({ status: "FAILED", error: cls.message, ...common }, row.attempts + 1);
      return "failed";
    }
    if (cls.outcome === "unsupported") {
      await finish({ status: "UNSUPPORTED", error: cls.message, sha256: got.sha256, ...common }, row.attempts + 1);
      return "unsupported";
    }
    const facts = pdfFacts(got.bytes);
    if (facts.encrypted) {
      await finish(
        {
          status: "UNSUPPORTED",
          error: "The PDF is password protected, so it cannot be read. Open it on the portal and check it yourself",
          sha256: got.sha256,
          ...common,
        },
        row.attempts + 1,
      );
      return "unsupported";
    }
    const path = tenderDocumentPath(tender.organisation_id, tenderId, got.sha256);
    try {
      await deps.storage.put(path, got.bytes, "application/pdf");
    } catch (err) {
      // A missing storage key or URL is a setting a person must fix, not a file problem: let the job fail with that message.
      if (err instanceof NonRetryableError) throw err;
      log.warn("tender document not stored", { error: (err as Error).message });
      if (row.attempts + 1 < MAX_FETCH_ATTEMPTS) {
        await finish({ status: "PENDING", error: "The file could not be stored; will try again" }, row.attempts + 1);
        return "retrying";
      }
      await finish({ status: "FAILED", error: "The file could not be stored" }, row.attempts + 1);
      return "failed";
    }
    await finish(
      { status: "DOWNLOADED", sha256: got.sha256, size: got.bytes.byteLength, pages: facts.pageCount, mime: "application/pdf", path },
      row.attempts + 1,
    );
    log.info("tender document fetched", { bytes: got.bytes.byteLength, pages: facts.pageCount });
    return "downloaded";
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return duplicate(got.sha256, common);
    throw err;
  }
}

async function announce(c: PoolClient, organisationId: string, tenderId: string, r: IngestResult): Promise<void> {
  const parts = [
    r.downloaded ? `${r.downloaded} fetched` : null,
    r.unsupported ? `${r.unsupported} not read yet (not a PDF, or protected)` : null,
    r.tooLarge ? `${r.tooLarge} too large` : null,
    r.failed ? `${r.failed} failed` : null,
    r.retrying ? `${r.retrying} will be tried again` : null,
  ].filter(Boolean);
  await db.emitEvent(c, {
    organisationId,
    type: "TENDER_DOCUMENTS_FETCHED",
    severity: r.failed || r.tooLarge ? "WARNING" : "INFO",
    summary: `Tender documents: ${parts.join(", ")}`,
    tenderId,
    payload: { ...r },
  });
}
