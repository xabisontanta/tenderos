import { z } from "zod";

/**
 * Connector for National Treasury's eTenders portal (www.etenders.gov.za).
 * It reads the same public JSON feed that powers the portal's "Current
 * tenders" list, which carries the province, closing date, briefing and
 * delivery details for every published tender.
 */
export const ETENDERS_BASE = "https://www.etenders.gov.za";
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

/**
 * What the portal sends is not under our control, so a row is read leniently: only the id has to be there. A
 * field of the wrong shape counts as missing (and the tender then says so, or is skipped when it is a fact the
 * tender cannot do without), instead of the whole row, or a whole page, being thrown away. Anything that is
 * still unreadable is counted (see `fetchOpenTenders` and `feedHealth`), never dropped silently.
 */
const text = z.unknown().transform((v): string | null => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null));
const flag = z.unknown().transform((v): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null));
const rowId = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,15}$/)], { error: "expected a number" }).transform(Number);

const documentSchema = z.object({
  supportDocumentID: z.union([z.string().min(1), z.number()]).transform(String),
  fileName: text,
  extension: text,
});
const documents = z.unknown().transform((v) =>
  Array.isArray(v)
    ? v.flatMap((d) => {
        const parsed = documentSchema.safeParse(d);
        return parsed.success ? [parsed.data] : [];
      })
    : [],
);

export const etendersRowSchema = z.object({
  id: rowId,
  tender_No: text,
  description: text,
  category: text,
  type: text,
  organ_of_State: text,
  department: text,
  status: text,
  closing_Date: text,
  date_Published: text,
  compulsory_briefing_session: text,
  briefingVenue: text,
  briefingSession: flag,
  briefingCompulsory: flag,
  province: text,
  delivery: text,
  contactPerson: text,
  email: text,
  telephone: text,
  eSubmission: flag,
  supportDocument: documents,
});
export type EtendersRow = z.infer<typeof etendersRowSchema>;

const pageSchema = z.object({
  recordsTotal: z.number(),
  data: z.array(z.unknown()),
});

// Control characters (NUL, which Postgres refuses in text and jsonb, but also bells and escapes pasted in from
// Word and PDFs), zero-width marks, and half of a surrogate pair.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​⁠﻿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes what cannot be stored: control characters except line breaks and tabs, and lone surrogates. */
export function sanitizeText(value: string): string {
  return value.replace(CONTROL_CHARS, "").replace(LONE_SURROGATE, "");
}

const PROVINCE_NAMES: Record<string, string> = {
  easterncape: "EASTERN_CAPE",
  freestate: "FREE_STATE",
  gauteng: "GAUTENG",
  kwazulunatal: "KWAZULU_NATAL",
  kzn: "KWAZULU_NATAL",
  limpopo: "LIMPOPO",
  mpumalanga: "MPUMALANGA",
  northwest: "NORTH_WEST",
  northerncape: "NORTHERN_CAPE",
  westerncape: "WESTERN_CAPE",
  national: "NATIONAL",
};

/** Maps the portal's province name ("KwaZulu-Natal", "North West") to our code. */
export function provinceCode(name: string | null | undefined): string {
  if (!name) return "UNKNOWN";
  return PROVINCE_NAMES[name.toLowerCase().replace(/[^a-z]/g, "")] ?? "UNKNOWN";
}

/** The portal publishes South African local times without an offset. */
export function saTime(value: string | null | undefined): string | null {
  if (!value || value.startsWith("0001-")) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}+02:00`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One line of clean text of at most `max` characters, or null when there is nothing real in it. */
function clean(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const v = sanitizeText(value).replace(/\s+/g, " ").trim();
  if (!v || v.toUpperCase() === "N/A") return null;
  // A cut can split a surrogate pair; sanitising again drops the dangling half.
  return v.length > max ? sanitizeText(`${v.slice(0, max - 1)}…`) : v;
}

/** `clean`, but only when the result is at least `min` characters (a column check wants more than "A1"). */
function usable(value: string | null | undefined, max: number, min: number): string | null {
  const v = clean(value, max);
  return v && v.length >= min ? v : null;
}

export interface DiscoveredDocument {
  name: string;
  url: string;
}

export interface DiscoveredTender {
  source_ref: string;
  reference_number: string | null;
  title: string;
  issuing_organisation: string;
  description: string | null;
  province: string;
  sector: string | null;
  published_at: string | null;
  closing_at: string;
  briefing_at: string | null;
  briefing_compulsory: boolean;
  briefing_location: string | null;
  submission_method: "ELECTRONIC_PORTAL" | "EMAIL" | "PHYSICAL" | "UNKNOWN";
  submission_destination: string | null;
  source_url: string;
  documents: DiscoveredDocument[];
  contact: { person: string | null; email: string | null; telephone: string | null };
}

export type MapResult = { ok: true; tender: DiscoveredTender } | { ok: false; reason: string };

/**
 * Turns one portal row into a tender record. Only facts present in the row
 * are kept; anything missing stays null so the agents report it as missing.
 */
export function mapEtendersRow(row: EtendersRow, now: Date): MapResult {
  const closing = saTime(row.closing_Date);
  if (!closing) return { ok: false, reason: "no closing date" };
  if (new Date(closing).getTime() <= now.getTime()) return { ok: false, reason: "already closed" };
  const organisation = usable(row.department, 200, 2) ?? usable(row.organ_of_State, 200, 2);
  if (!organisation) return { ok: false, reason: "no issuing organisation" };

  const description = row.description ? sanitizeText(row.description.replace(/\r\n?/g, "\n").trim().slice(0, 10000)).trim() || null : null;
  const reference = clean(row.tender_No, 120);
  // The tenders table wants a title of 3 to 300 characters. Take the first real line of the description; failing
  // that the reference number; failing that the portal's own id, so one untitled row never costs the whole scan.
  let title: string | null = null;
  for (const line of description?.split("\n") ?? []) {
    title = usable(line, 300, 3);
    if (title) break;
  }
  title ??= (reference && reference.length >= 3 ? reference : null) ?? `eTenders ${row.id}`;

  let published = saTime(row.date_Published);
  if (published && published > closing) published = null;
  let briefing = saTime(row.compulsory_briefing_session);
  if (briefing && briefing > closing) briefing = null;

  const delivery = clean(row.delivery ? sanitizeText(row.delivery).replace(/-+/g, ", ") : null, 500);
  // A delivery field that names a mailbox means the bid goes by email.
  const deliveryEmail = delivery?.match(EMAIL_IN_TEXT)?.[0].toLowerCase() ?? null;
  const method: DiscoveredTender["submission_method"] = row.eSubmission ? "ELECTRONIC_PORTAL" : deliveryEmail ? "EMAIL" : delivery ? "PHYSICAL" : "UNKNOWN";

  const documents = row.supportDocument.map((d) => {
    const id = sanitizeText(d.supportDocumentID);
    const ext = sanitizeText(d.extension ?? "");
    const name = clean(d.fileName, 255) ?? `${id}${ext}`;
    return {
      name,
      url: `${ETENDERS_BASE}/home/Download?blobName=${encodeURIComponent(id + ext)}&downloadedFileName=${encodeURIComponent(name)}`,
    };
  });

  return {
    ok: true,
    tender: {
      source_ref: String(row.id),
      reference_number: reference,
      title,
      issuing_organisation: organisation,
      description,
      province: provinceCode(row.province),
      sector: clean(row.category, 120),
      published_at: published,
      closing_at: closing,
      briefing_at: row.briefingSession ? briefing : null,
      briefing_compulsory: Boolean(row.briefingCompulsory),
      briefing_location: row.briefingSession ? clean(row.briefingVenue, 300) : null,
      submission_method: method,
      submission_destination: method === "ELECTRONIC_PORTAL" ? `${ETENDERS_BASE} (eSubmission)` : method === "EMAIL" ? deliveryEmail : delivery,
      source_url: documents[0]?.url ?? `${ETENDERS_BASE}/Home/opportunities?id=1`,
      documents,
      contact: { person: clean(row.contactPerson, 120), email: clean(row.email, 200), telephone: clean(row.telephone, 60) },
    },
  };
}

export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const PAGE_TIMEOUT_MS = 30_000;

export interface FeedPage {
  /** Rows that could be read. */
  rows: EtendersRow[];
  total: number;
  /** Rows the portal sent on this page. */
  seen: number;
  /** Rows that could not be read at all (no usable id, or not even an object). */
  unreadable: number;
  /** What was wrong with them, as text → how many: field names and the expected shape, never their values. */
  reasons: Record<string, number>;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return `${issue.path.join(".") || "row"}: ${issue.message}`.slice(0, 160);
}

/**
 * Reads every currently published tender, page by page. Rows that cannot be read are counted and described,
 * not thrown away silently and not allowed to fail the page.
 */
export async function* fetchOpenTenders(fetcher: Fetcher, signal?: AbortSignal): AsyncGenerator<FeedPage> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ETENDERS_BASE}/Home/PaginatedTenderOpportunities?draw=${page + 1}&start=${page * PAGE_SIZE}&length=${PAGE_SIZE}&status=1`;
    // A page that hangs must not hold the worker: give each request 30 seconds.
    const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
    const res = await fetcher(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { accept: "application/json", "user-agent": "TenderOS tender discovery" },
    });
    if (!res.ok) throw new Error(`eTenders returned HTTP ${res.status}`);
    const body = pageSchema.parse(await res.json());
    const rows: EtendersRow[] = [];
    const reasons: Record<string, number> = {};
    let unreadable = 0;
    for (const raw of body.data) {
      const parsed = etendersRowSchema.safeParse(raw);
      if (parsed.success) rows.push(parsed.data);
      else {
        unreadable++;
        const why = describeIssue(parsed.error);
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
    }
    yield { rows, total: body.recordsTotal, seen: body.data.length, unreadable, reasons };
    if (body.data.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= body.recordsTotal) return;
  }
}

export interface FeedStats {
  /** Rows the portal sent. */
  seen: number;
  /** Rows that could not become a tender because they were malformed (not closed tenders: those are normal). */
  unreadable: number;
  /** Why, as short text → how many. */
  reasons: Record<string, number>;
}

export type FeedHealth = { ok: true } | { ok: false; message: string };

/**
 * Decides whether a feed was readable enough to trust. A scan that reads almost nothing must fail loudly, not
 * report "completed, 0 matched": that is what the portal changing its format would otherwise look like.
 */
export function feedHealth(stats: FeedStats, maxInvalidRatio: number): FeedHealth {
  if (stats.seen === 0 || stats.unreadable / stats.seen <= maxInvalidRatio + 1e-9) return { ok: true };
  const top = Object.entries(stats.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => `${n} × ${reason}`)
    .join(", ");
  return {
    ok: false,
    message:
      `eTenders returned ${stats.seen} rows and ${stats.unreadable} (${Math.round((stats.unreadable / stats.seen) * 100)}%) could not be read, more than the ` +
      `${Math.round(maxInvalidRatio * 100)}% allowed. The portal may have changed its format.${top ? ` Mostly: ${top}.` : ""}`,
  };
}

/** The share of unreadable rows a scan tolerates: DISCOVERY_MAX_INVALID_PCT percent, 20 by default. */
export function maxInvalidRatioFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.DISCOVERY_MAX_INVALID_PCT?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return 0.2;
  const pct = Number(raw);
  return pct >= 0 && pct <= 100 ? pct / 100 : 0.2;
}
